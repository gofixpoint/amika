/** Cover the StrictModes check bare-metal setup runs on amikad's state. */
import { describe, expect, it } from "vitest";
import {
  describeStrictModesViolation,
  strictModesViolation,
  type PathOwner,
} from "./strict-modes.js";

const ME = 1001;
const DIR = 0o040000;

/** A filesystem of `path -> [uid, permission bits]`; links map in `links`. */
function fs(
  entries: Record<string, [number, number]>,
  links: Record<string, string> = {},
) {
  return {
    uid: ME,
    stat: (file: string): PathOwner | undefined => {
      const entry = entries[file];
      return entry && { uid: entry[0], mode: DIR | entry[1] };
    },
    realpath: (file: string) => links[file] ?? file,
  };
}

const UBUNTU_HOME = {
  "/": [0, 0o755],
  "/home": [0, 0o755],
  "/home/jo": [ME, 0o750],
  "/home/jo/.local": [ME, 0o755],
  "/home/jo/.local/state": [ME, 0o700],
} satisfies Record<string, [number, number]>;

const STATE = "/home/jo/.local/state/amika-hostd/amikad";

describe("strictModesViolation", () => {
  it("accepts a chain owned by root or this user, writable by neither group nor others", () => {
    expect(strictModesViolation(STATE, fs(UBUNTU_HOME))).toBeUndefined();
  });

  it("names a group-writable directory, as Ubuntu's umask 002 leaves ~/.local", () => {
    const violation = strictModesViolation(
      STATE,
      fs({ ...UBUNTU_HOME, "/home/jo/.local": [ME, 0o775] }),
    );
    expect(violation).toMatchObject({
      dir: "/home/jo/.local",
      problem: "writable",
    });
  });

  it("names a world-writable directory, sticky or not", () => {
    expect(
      strictModesViolation(
        "/tmp/state/amikad",
        fs({ "/": [0, 0o755], "/tmp": [0, 0o1777] }),
      ),
    ).toMatchObject({ dir: "/tmp", problem: "writable" });
  });

  it("names a directory owned by another account", () => {
    expect(
      strictModesViolation(
        STATE,
        fs({ ...UBUNTU_HOME, "/home/jo/.local": [1002, 0o755] }),
      ),
    ).toMatchObject({ dir: "/home/jo/.local", problem: "owner" });
  });

  it("checks the directory itself when it exists", () => {
    expect(
      strictModesViolation(
        STATE,
        fs({
          ...UBUNTU_HOME,
          "/home/jo/.local/state/amika-hostd": [ME, 0o700],
          [STATE]: [ME, 0o770],
        }),
      ),
    ).toMatchObject({ dir: STATE, problem: "writable" });
  });

  it("checks where a linked home really lives", () => {
    const violation = strictModesViolation(
      STATE,
      fs(
        {
          ...UBUNTU_HOME,
          "/data": [0, 0o777],
          "/data/jo": [ME, 0o750],
          "/data/jo/.local": [ME, 0o755],
          "/data/jo/.local/state": [ME, 0o700],
        },
        { "/home/jo/.local/state": "/data/jo/.local/state" },
      ),
    );
    expect(violation).toMatchObject({ dir: "/data", problem: "writable" });
  });
});

describe("describeStrictModesViolation", () => {
  it("gives the chmod that fixes a writable directory", () => {
    const message = describeStrictModesViolation(
      {
        dir: "/home/jo/.local",
        problem: "writable",
        owner: { uid: ME, mode: DIR | 0o775 },
      },
      STATE,
    );
    expect(message).toContain(
      "/home/jo/.local is writable by its group or by everyone (mode 775)",
    );
    expect(message).toContain("`chmod go-w /home/jo/.local`");
    expect(message).toContain(`amikad's state (${STATE})`);
    expect(message).toContain("nothing was changed");
  });

  it("names the owner of a directory it cannot fix with chmod", () => {
    expect(
      describeStrictModesViolation(
        {
          dir: "/home/jo/.local",
          problem: "owner",
          owner: { uid: 1002, mode: DIR | 0o755 },
        },
        STATE,
      ),
    ).toMatch(/owned by uid 1002, not by you or root.*XDG_STATE_HOME/);
  });
});
