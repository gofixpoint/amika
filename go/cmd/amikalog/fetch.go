package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/spf13/cobra"
)

var fetchCmd = &cobra.Command{
	Use:   "beta:fetch <destination>",
	Short: "Download your organization's captured events to a local directory",
	Long: `Download your organization's captured events into <destination>, a local
directory that is created if it does not exist.

Set AMIKA_API_KEY to authenticate.`,
	Args:          cobra.ExactArgs(1),
	SilenceUsage:  true,
	SilenceErrors: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		key := os.Getenv(config.EnvAPIKey)
		if key == "" {
			return fmt.Errorf("set %s to fetch; amikalog authenticates with an org API key only", config.EnvAPIKey)
		}
		client := apiclient.NewClientWithTokenSource(config.APIURL(), apiclient.NewStaticTokenSource(key))
		n, err := runFetch(apiBucketDownloader{client: client}, args[0])
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "fetched %d object(s) -> %s\n", n, args[0])
		return nil
	},
}

// bucketObject is one downloadable object: its bucket key and a signed URL to
// fetch its bytes.
type bucketObject struct {
	key         string
	downloadURL string
}

// bucketDownloader lists the org bucket one page at a time and fetches the
// bytes for any one object.
type bucketDownloader interface {
	// ListPage returns one page of objects and the cursor for the next page, or
	// "" when this is the last page. Pass "" to fetch the first page.
	ListPage(cursor string) (objs []bucketObject, nextCursor string, err error)
	// Get retrieves the bytes for one object.
	Get(obj bucketObject) ([]byte, error)
}

// downloadPageLimit is the page size requested when listing the bucket.
const downloadPageLimit = 1000

// fetchConcurrency bounds how many objects in a page are downloaded at once.
const fetchConcurrency = 8

// apiBucketDownloader adapts the Amika API client to bucketDownloader: it lists
// the bucket one page at a time and GETs each object's signed download URL.
type apiBucketDownloader struct {
	client *apiclient.Client
}

func (a apiBucketDownloader) ListPage(cursor string) ([]bucketObject, string, error) {
	resp, err := a.client.ListDownloads("", cursor, downloadPageLimit)
	if err != nil {
		return nil, "", err
	}
	objs := make([]bucketObject, 0, len(resp.Objects))
	for _, o := range resp.Objects {
		objs = append(objs, bucketObject{key: o.Key, downloadURL: o.DownloadURL})
	}
	next := ""
	if resp.NextCursor != nil {
		next = *resp.NextCursor
	}
	return objs, next, nil
}

func (a apiBucketDownloader) Get(obj bucketObject) ([]byte, error) {
	return a.client.DownloadFromSignedURL(obj.downloadURL)
}

// runFetch downloads every object in the org bucket and writes each under
// destDir at its bucket key, recreating the bucket's directory tree. It returns
// the number of objects written.
//
// Objects are downloaded page by page: each page's objects are fetched (in
// parallel, bounded by fetchConcurrency) before the next page is listed, so a
// signed download URL is used promptly after it is issued rather than after the
// whole (possibly multi-page) listing completes — keeping first-page URLs from
// expiring on large buckets.
func runFetch(d bucketDownloader, destDir string) (int, error) {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return 0, fmt.Errorf("creating destination dir: %w", err)
	}
	// Resolve the destination to its real path once. bucketObjectPath's textual
	// check (via filepath.Abs) does not follow symlinks, so a pre-existing
	// symlinked component under destDir could otherwise redirect a write outside
	// it; each object's parent is re-resolved against this root below.
	realRoot, err := filepath.EvalSymlinks(destDir)
	if err != nil {
		return 0, fmt.Errorf("resolving destination dir: %w", err)
	}

	total := 0
	cursor := ""
	for {
		objs, next, err := d.ListPage(cursor)
		if err != nil {
			return total, err
		}
		n, err := downloadPage(d, destDir, realRoot, objs)
		total += n
		if err != nil {
			return total, err
		}
		if next == "" {
			return total, nil
		}
		cursor = next
	}
}

// downloadPage downloads objs concurrently into destDir, returning how many
// were written. It stops scheduling new downloads once one fails and returns
// the first error after in-flight downloads drain.
func downloadPage(d bucketDownloader, destDir, realRoot string, objs []bucketObject) (int, error) {
	var (
		mu        sync.Mutex
		firstErr  error
		written   int
		wg        sync.WaitGroup
		semaphore = make(chan struct{}, fetchConcurrency)
	)
	for _, obj := range objs {
		obj := obj
		mu.Lock()
		stop := firstErr != nil
		mu.Unlock()
		if stop {
			break
		}

		semaphore <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-semaphore }()

			if err := downloadObject(d, destDir, realRoot, obj); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			written++
			mu.Unlock()
		}()
	}
	wg.Wait()
	return written, firstErr
}

// downloadObject fetches one object and writes it under destDir at its key,
// rejecting any key or pre-existing symlink that would escape destDir.
func downloadObject(d bucketDownloader, destDir, realRoot string, obj bucketObject) error {
	target, err := bucketObjectPath(destDir, obj.key)
	if err != nil {
		return err
	}
	if err := ensureSafeParent(filepath.Dir(target), realRoot); err != nil {
		return fmt.Errorf("object key %q: %w", obj.key, err)
	}
	if err := rejectSymlink(target); err != nil {
		return fmt.Errorf("object key %q: %w", obj.key, err)
	}
	data, err := d.Get(obj)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", obj.key, err)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", target, err)
	}
	return nil
}

// ensureSafeParent creates dir and verifies its real (symlink-resolved) path
// stays within realRoot, so a symlinked path component cannot redirect a write
// outside the destination.
func ensureSafeParent(dir, realRoot string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating destination dir: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return fmt.Errorf("resolving destination dir: %w", err)
	}
	if resolved != realRoot && !strings.HasPrefix(resolved, realRoot+string(os.PathSeparator)) {
		return fmt.Errorf("path escapes the destination directory via a symlink")
	}
	return nil
}

// rejectSymlink refuses to write through an existing symlink at path, so a
// planted symlink at the object's own location cannot redirect the write
// outside the destination.
func rejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("destination path is a symlink")
	}
	return nil
}

// bucketObjectPath resolves the local path for a bucket key under destDir,
// preserving the key's directory structure. It rejects keys that would escape
// destDir (e.g. via ".."), so a malformed listing cannot write outside the
// target directory.
func bucketObjectPath(destDir, key string) (string, error) {
	target := filepath.Join(destDir, filepath.FromSlash(key))
	// Compare absolute paths so a relative destination like "." (the current
	// directory) works: a textual prefix check would reject every object because
	// filepath.Join(".", key) drops the leading "./", yet the bytes still land
	// safely inside the destination.
	absDest, err := filepath.Abs(destDir)
	if err != nil {
		return "", fmt.Errorf("resolving destination dir: %w", err)
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", fmt.Errorf("resolving target path: %w", err)
	}
	if absTarget != absDest && !strings.HasPrefix(absTarget, absDest+string(os.PathSeparator)) {
		return "", fmt.Errorf("object key %q escapes destination directory", key)
	}
	return target, nil
}

func init() {
	rootCmd.AddCommand(fetchCmd)
}
