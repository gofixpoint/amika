/** Cover reading a guest's answer to an upgrade: status, head and body end. */
import { describe, expect, it } from "vitest";
import {
  answerBody,
  answerStatus,
  closingHead,
  type AnswerBody,
} from "./upgrade-answer.js";

describe("answerStatus", () => {
  it.each([
    ["HTTP/1.1 101 Switching Protocols", 101],
    ["HTTP/1.0 401 Unauthorized\r\nContent-Length: 0", 401],
    ["HTTP/1.1 204", 204],
  ])("reads %j", (head, status) => {
    expect(answerStatus(head)).toBe(status);
  });

  it.each(["", "SSH-2.0-OpenSSH", "HTTP/1.1 2000 Wide", "HTTP/1.1 20"])(
    "finds no status in %j",
    (head) => {
      expect(answerStatus(head)).toBeNull();
    },
  );
});

describe("closingHead", () => {
  it("replaces the guest's connection fields with Connection: close", () => {
    expect(
      closingHead(
        "HTTP/1.1 401 Unauthorized\r\nconnection: keep-alive\r\nKeep-Alive: timeout=5,\r\n max=100\r\nContent-Length: 0",
      ),
    ).toBe(
      "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close",
    );
  });

  it("adds Connection: close to a bare status line", () => {
    expect(closingHead("HTTP/1.1 404 Not Found")).toBe(
      "HTTP/1.1 404 Not Found\r\nConnection: close",
    );
  });
});

describe("answerBody", () => {
  /** Feed `parts` in order; the body's length and whether it finished. */
  function feed(body: AnswerBody, ...parts: string[]) {
    let length = 0;
    for (const part of parts) {
      const taken = body.take(Buffer.from(part, "latin1"));
      if (taken === null) return null;
      length += taken.length;
      if (taken.done) return { length, done: true };
    }
    return { length, done: false };
  }

  function bodyOf(head: string, method = "GET"): AnswerBody {
    const body = answerBody(head, method);
    if (body === null) throw new Error("no body");
    return body;
  }

  it.each([
    ["a 204", "HTTP/1.1 204 No Content\r\nContent-Length: 5", "GET"],
    ["a 304", "HTTP/1.1 304 Not Modified\r\nContent-Length: 5", "GET"],
    [
      "a HEAD request",
      "HTTP/1.1 401 Unauthorized\r\nContent-Length: 5",
      "HEAD",
    ],
  ])("has no body for %s", (_label, head, method) => {
    expect(feed(bodyOf(head, method), "next")).toEqual({
      length: 0,
      done: true,
    });
  });

  it("ends after Content-Length bytes, across reads", () => {
    const body = bodyOf("HTTP/1.1 401 Unauthorized\r\ncontent-length: 9");
    expect(body.untilClose).toBe(false);
    expect(feed(body, "bad ", "tokenGET / HTTP/1.1")).toEqual({
      length: 9,
      done: true,
    });
  });

  it("takes repeated identical lengths", () => {
    const body = bodyOf(
      "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2, 2\r\nContent-Length: 2",
    );
    expect(feed(body, "ok")).toEqual({ length: 2, done: true });
  });

  it.each([
    ["conflicting lengths", "Content-Length: 2\r\nContent-Length: 3"],
    ["a negative length", "Content-Length: -1"],
    ["a length that is no number", "Content-Length: two"],
  ])("refuses %s", (_label, field) => {
    expect(answerBody(`HTTP/1.1 401 Unauthorized\r\n${field}`, "GET")).toBe(
      null,
    );
  });

  it("refuses a head with no status line", () => {
    expect(answerBody("Content-Length: 0", "GET")).toBeNull();
  });

  it("runs to the close with no length", () => {
    const body = bodyOf("HTTP/1.0 401 Unauthorized");
    expect(body.untilClose).toBe(true);
    expect(feed(body, "anything", "more")).toEqual({
      length: 12,
      done: false,
    });
  });

  it("runs to the close for a coding other than chunked last", () => {
    const body = bodyOf(
      "HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked, gzip\r\nContent-Length: 4",
    );
    expect(body.untilClose).toBe(true);
  });

  describe("chunked", () => {
    const head =
      "HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: gzip, chunked";

    it("ends after the last chunk and trailers, across reads", () => {
      const chunked =
        "4;ext=1\r\nbad \r\n5\r\ntoken\r\n0\r\nX-Trailer: 1\r\n\r\n";
      expect(feed(bodyOf(head), chunked, "GET / HTTP/1.1")).toEqual({
        length: chunked.length,
        done: true,
      });
      const body = bodyOf(head);
      expect(body.untilClose).toBe(false);
      expect(feed(body, ...chunked.split(""))).toEqual({
        length: chunked.length,
        done: true,
      });
    });

    it("ends after a last chunk with no trailers", () => {
      expect(feed(bodyOf(head), "0\r\n\r\nnext")).toEqual({
        length: 5,
        done: true,
      });
    });

    it("waits for the blank line after the trailers", () => {
      expect(feed(bodyOf(head), "0\r\nX-Trailer: 1\r\n")).toEqual({
        length: 17,
        done: false,
      });
    });

    it.each([
      ["a size that is no hex", "zz\r\n"],
      ["data that overruns its size", "2\r\nabc\r\n"],
      ["a size line past the bound", "1".repeat(70 * 1024)],
    ])("refuses %s", (_label, bytes) => {
      expect(feed(bodyOf(head), bytes)).toBeNull();
    });
  });
});
