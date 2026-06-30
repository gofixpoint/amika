package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/eventlog"
	"github.com/spf13/cobra"
)

// uploadMemories opts into uploading Claude memory files alongside captured
// events. allMemoryProjects extends that to projects with no captured session.
// mergeMemories reconciles files that diverged on both sides; without it such
// files are skipped with a warning. mergeSkipPermissions runs that merge with
// claude's --dangerously-skip-permissions.
var (
	uploadMemories       bool
	allMemoryProjects    bool
	mergeMemories        bool
	mergeSkipPermissions bool
)

var pushCmd = &cobra.Command{
	Use:   "beta:push",
	Short: "Upload captured events to your organization",
	Long: `Upload captured events that have not been pushed yet. Repeated runs upload
only events captured since the last push.

Pass --memories to also upload Claude memory files
(~/.claude/projects/<project>/memory/*.md) for the projects you have captured
sessions for. Files that changed only locally or only in the cloud sync
automatically; a file that changed on both sides is left untouched and reported,
unless you pass --merge, which reconciles it with the local claude CLI. Add
--all-projects to include projects with no captured session.

--merge runs claude in a locked-down mode that cannot execute tools. Only pass
--dangerously-skip-permissions if you fully trust every memory file being
merged, since the cloud copy fed to the merge can be written by anyone with
access to the bucket.

Set AMIKA_API_KEY to authenticate.`,
	Args:          cobra.NoArgs,
	SilenceUsage:  true,
	SilenceErrors: true,
	RunE: func(cmd *cobra.Command, _ []string) error {
		if allMemoryProjects && !uploadMemories {
			return fmt.Errorf("--all-projects requires --memories")
		}
		if mergeMemories && !uploadMemories {
			return fmt.Errorf("--merge requires --memories")
		}
		if mergeSkipPermissions && !mergeMemories {
			return fmt.Errorf("--dangerously-skip-permissions requires --merge")
		}
		key := os.Getenv(config.EnvAPIKey)
		if key == "" {
			return fmt.Errorf("set %s to push; amikalog authenticates with an org API key only", config.EnvAPIKey)
		}
		stateDir, err := config.StateDir()
		if err != nil {
			return fmt.Errorf("resolving state directory: %w", err)
		}

		client := apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewStaticTokenSource(key))
		uploader := apiUploader{client: client}
		out := cmd.OutOrStdout()
		errOut := cmd.ErrOrStderr()

		report, err := eventlog.Push(stateDir, uploader)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "uploaded %d, skipped %d, failed %d\n", report.Uploaded, report.Skipped, report.Failed)
		for _, e := range report.Errors {
			fmt.Fprintf(errOut, "amikalog: %v\n", e)
		}
		failed := report.Failed

		if uploadMemories {
			home, herr := os.UserHomeDir()
			if herr != nil {
				return fmt.Errorf("resolving home directory: %w", herr)
			}
			mreport, merr := eventlog.PushMemories(stateDir, home, allMemoryProjects, mergeMemories, uploader, apiDownloader{client: client}, eventlog.NewClaudeMerger(mergeSkipPermissions))
			if merr != nil {
				return fmt.Errorf("pushing memories: %w", merr)
			}
			fmt.Fprintf(out, "memories: uploaded %d, merged %d, pulled %d, skipped %d, failed %d\n",
				mreport.Uploaded, mreport.Merged, mreport.Pulled, mreport.Skipped, mreport.Failed)
			for _, w := range mreport.Warnings {
				fmt.Fprintf(errOut, "amikalog: %s\n", w)
			}
			for _, e := range mreport.Errors {
				fmt.Fprintf(errOut, "amikalog: %v\n", e)
			}
			failed += mreport.Failed
		}

		if failed > 0 {
			return fmt.Errorf("%d file(s) failed to upload", failed)
		}
		return nil
	},
}

// apiUploader adapts the Amika API client to eventlog.Uploader: it requests a
// signed URL for each object key and PUTs the bytes to it.
type apiUploader struct {
	client *apiclient.Client
}

func (a apiUploader) Upload(objectKey string, data []byte) error {
	resp, err := a.client.CreateUploadBatch(apiclient.CreateUploadBatchRequest{
		// Upsert so re-pushing is idempotent: event files are append-only and
		// their object keys are deterministic, so if a PUT succeeded but the
		// manifest write was lost (interrupted run, failed write), the next push
		// re-uploads identical bytes and must overwrite rather than fail on the
		// already-existing object.
		Files: []apiclient.UploadFile{{Filename: objectKey, Upsert: true}},
	})
	if err != nil {
		return err
	}
	if len(resp.Objects) == 0 {
		return fmt.Errorf("no signed upload URL returned for %s", objectKey)
	}
	return a.client.UploadToSignedURL(resp.Objects[0].UploadURL, data, "application/json")
}

// apiDownloader adapts the Amika API client to eventlog.Downloader: it fetches a
// single object's current bytes by key, used to detect whether a memory file's
// cloud copy has diverged before overwriting it.
type apiDownloader struct {
	client *apiclient.Client
}

func (a apiDownloader) Fetch(objectKey string) ([]byte, bool, error) {
	return a.client.GetObjectByKey(objectKey)
}

func init() {
	pushCmd.Flags().BoolVar(&uploadMemories, "memories", false, "Also upload Claude memory files for projects with captured sessions")
	pushCmd.Flags().BoolVar(&allMemoryProjects, "all-projects", false, "With --memories, include projects that have no captured session")
	pushCmd.Flags().BoolVar(&mergeMemories, "merge", false, "With --memories, reconcile files that changed both locally and in the cloud with the local claude CLI (otherwise such files are skipped with a warning)")
	pushCmd.Flags().BoolVar(&mergeSkipPermissions, "dangerously-skip-permissions", false, "With --merge, run the claude merge with --dangerously-skip-permissions (UNSAFE: lets attacker-influenced memory content execute commands on this host)")
	rootCmd.AddCommand(pushCmd)
}
