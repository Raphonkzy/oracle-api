import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { collectAllowed, parseUserAmounts, ungroundedFigures } from "@oracle/core";
import { hasCode, hasLink, hasTable, hasTag, isMarkerLeak, logCheck, looksOffTopic, normalizePlainText, rejectRule, stripReasoning } from "../src/ai/checks";
import { limitReply } from "../src/ai/text";

describe("reply checks", () => {
  describe("reasoning removal", () => {
    it("removes a closed block, case-insensitively and across lines", () => {
      assert.equal(stripReasoning("<think>secret\nplan</think>Answer."), "Answer.");
      assert.equal(stripReasoning("A <THINK>x</THINK>B"), "A B");
    });
    it("cuts from an unclosed block to the end", () => {
      assert.equal(stripReasoning("Answer. <think>never closed and more"), "Answer.");
      assert.equal(stripReasoning("<think>only reasoning"), "");
    });
    it("leaves text with no block alone", () => {
      assert.equal(stripReasoning("You spent Rp 1,000."), "You spent Rp 1,000.");
    });
  });

  describe("reject rules", () => {
    it("R-CODE: a code fence", () => {
      assert.ok(hasCode("a\n```js\nx\n```"));
      assert.ok(hasCode("~~~\nx"));
      assert.ok(!hasCode("plain `tick` text"));
      assert.equal(rejectRule("```x```"), "code");
    });
    it("R-LINK: a URL or a markdown link", () => {
      for (const t of ["see https://x.example", "go to www.x.example", "[here](javascript:alert(1))"]) assert.ok(hasLink(t), t);
      assert.ok(!hasLink("no link here"));
      assert.equal(rejectRule("see https://x.example"), "link");
    });
    it("R-TAG: a markup tag", () => {
      assert.ok(hasTag("<script>alert(1)</script>"));
      assert.ok(hasTag("<img src=x>"));
      assert.ok(!hasTag("5 < 6 and 7 > 3"));
      assert.equal(rejectRule("<b>x</b>"), "tag");
    });
    it("R-TABLE: a table row or a separator line", () => {
      assert.ok(hasTable("| a | b |\n| --- | --- |\n| 1 | 2 |"));
      assert.ok(hasTable("a\n---|---\nb"));
      assert.ok(!hasTable("one | two"));
      assert.equal(rejectRule("| a | b |"), "table");
    });
    it("R-MARKER: the turn's marker, or anything shaped like one", () => {
      assert.ok(isMarkerLeak("it is ORC-0a1b2c3d here", "ORC-0a1b2c3d"));
      assert.ok(isMarkerLeak("ORC-ffffffff"));
      assert.ok(!isMarkerLeak("ORC-xyz and orchestra"));
      assert.equal(rejectRule("x ORC-0a1b2c3d", "ORC-0a1b2c3d"), "marker");
    });
    it("a clean reply passes", () => {
      assert.equal(rejectRule("You spent Rp 240,000 this week.", "ORC-00000000"), null);
    });
  });

  describe("normalization", () => {
    it("N-HEADING removes heading markers and keeps the text", () => {
      assert.equal(normalizePlainText("## Summary\nText"), "Summary\nText");
    });
    it("N-EMPHASIS removes **, __ and ~~ and leaves a single *", () => {
      assert.equal(normalizePlainText("**bold** and __under__ and ~~gone~~ 2*3"), "bold and under and gone 2*3");
    });
    it("N-CODE-TICK removes backticks", () => {
      assert.equal(normalizePlainText("use `Home` now"), "use Home now");
    });
    it("N-BULLET turns * and • bullets into '- '", () => {
      assert.equal(normalizePlainText("* one\n• two\n- three"), "- one\n- two\n- three");
    });
    it("N-SPACE collapses three or more newlines to two", () => {
      assert.equal(normalizePlainText("a\n\n\n\nb"), "a\n\nb");
    });
    it("never rejects, and leaves plain prose as it is", () => {
      assert.equal(normalizePlainText("You spent Rp 1,000."), "You spent Rp 1,000.");
    });
  });

  describe("looksOffTopic", () => {
    it("catches code, links and active tags", () => {
      for (const t of ["```x```", "~~~", "https://a.example", "www.a.example", "[a](b)", "<script>", "<iframe src=x>", "<img src=x>", "<a href=x>"]) assert.ok(looksOffTopic(t), t);
    });
    it("lets an ordinary answer through", () => {
      assert.ok(!looksOffTopic("You spent Rp 1,000 on food."));
    });
  });

  describe("logging", () => {
    let warn: ReturnType<typeof mock.method>;
    beforeEach(() => {
      warn = mock.method(console, "warn", () => {});
    });
    afterEach(() => warn.mock.restore());
    it("writes only the fixed rule name, never the reply text", () => {
      const reply = "My secret reply with Rp 999,000 and ```code```";
      const rule = rejectRule(reply);
      assert.equal(rule, "code");
      logCheck(`reply-check:${rule}`);
      assert.equal(warn.mock.callCount(), 1);
      const logged = warn.mock.calls.map((c) => c.arguments.join(" ")).join(" ");
      assert.equal(logged, "reply-check:code");
      assert.ok(!logged.includes("secret") && !logged.includes("999"));
    });
  });
});

describe("length cap", () => {
  it("leaves text under 4,000 characters unchanged", () => {
    const text = `${"Short sentence. ".repeat(100)}`.trim();
    assert.equal(limitReply(text), text);
    assert.equal(limitReply("x".repeat(4000)), "x".repeat(4000));
  });
  it("cuts longer text at the last sentence end inside the limit", () => {
    const text = `${"This is a sentence. ".repeat(300)}`;
    const out = limitReply(text);
    assert.ok(out.length <= 4000);
    assert.ok(out.endsWith("."), out.slice(-20));
    assert.ok(out.length > 3900, "it keeps nearly everything that fits");
  });
  it("also ends at ! and ? and at a newline", () => {
    assert.equal(limitReply(`Hello there! ${"x".repeat(50)}`, 30), "Hello there!");
    assert.equal(limitReply(`Really? ${"x".repeat(50)}`, 30), "Really?");
    assert.equal(limitReply(`line one\n${"x".repeat(50)}`, 30), "line one");
  });
  it("cuts at the limit when there is no sentence end", () => {
    assert.equal(limitReply("x".repeat(5000)), "x".repeat(4000));
    assert.equal(limitReply("3.14159 ".repeat(1000).replace(/ /g, "")).length, 4000);
  });
  it("does not treat a number's decimal point as a sentence end", () => {
    assert.equal(limitReply(`${"1.5".repeat(20)}`, 10), "1.51.51.51");
  });
});

describe("the figure check", () => {
  const allowedFrom = (typed: string, data: unknown = {}) => {
    const allowed = collectAllowed(typed);
    for (const n of parseUserAmounts(typed)) allowed.amounts.add(n);
    collectAllowed(data, allowed);
    return allowed;
  };
  it("passes an amount that is in the tool results", () => {
    assert.deepEqual(ungroundedFigures("You spent Rp 1,250,000.", allowedFrom("how much", { total: 1_250_000 })), []);
  });
  it("passes an amount the person typed", () => {
    assert.deepEqual(ungroundedFigures("Is Rp 1,250,000 enough?", allowedFrom("is 1.250.000 enough")), []);
  });
  it("fails an amount that is in neither", () => {
    assert.equal(ungroundedFigures("You spent Rp 1,250,000.", allowedFrom("how much", { total: 5 })).length, 1);
  });
  it("checks a percentage the same way", () => {
    assert.deepEqual(ungroundedFigures("Spending is up 40%.", allowedFrom("compare", { changePct: 40 })), []);
    assert.deepEqual(ungroundedFigures("Spending is up 40%.", allowedFrom("is it up 40%?")), []);
    assert.equal(ungroundedFigures("Spending is up 40%.", allowedFrom("compare", { changePct: 12 })).length, 1);
  });
});
