let meta = #{
    name: "needle-compaction",
    description: "Compact a transcript with Cactus Needle 3 on CPU (no API key) and sanity-check the result",
    phases: [
        #{ title: "Compact", detail: "run the Needle 3 library on the transcript" },
        #{ title: "Verify", detail: "sanity-check the compaction output" },
    ],
};

let transcript = if args == () { () } else { args.transcript };
if transcript == () {
    pause("verification", "Pass args.transcript — path to a JSON transcript file (an array of Message objects).");
}

phase("Compact");
let compact_out = agent(
    "You are in the fast-jev-compaction repo (your cwd). Compact the transcript file "
        + transcript
        + " using the library's on-device Needle 3 path (no API key). "
        + "1) Write /tmp/nc.js as an ESM script: import { compactMessagesNeedle } from 'fast-jev-compaction'; "
        + "const fs = require('node:fs'); const t = JSON.parse(fs.readFileSync("
        + json_encode(transcript) + ", 'utf8')); "
        + "const r = await compactMessagesNeedle(t, { preserveRecentMessages: 4 }); "
        + "console.log(JSON.stringify(r.stats)); console.log('--- MESSAGES ---'); "
        + "console.log(JSON.stringify(r.messages, null, 2)); "
        + "2) Run it with: node /tmp/nc.js. "
        + "3) Report the exact stdout verbatim. "
        + "If the command fails (missing needle3.cact, WASM error, JSON parse error, etc.), report the exact error text. "
        + "Do not invent results.",
    #{ label: "compact", capability_mode: "execute" }
);

if compact_out == () || !compact_out.success {
    let error_msg = "compact agent did not return";
    if compact_out != () {
        error_msg = compact_out.output;
    }
    complete(#{
        status: "failed",
        transcript: transcript,
        error: error_msg,
    });
}

phase("Verify");
let verify_out = agent(
    "Sanity-check a Needle 3 compaction output. The output is below. "
        + "Check each and answer PASS or FAIL with a one-line reason: "
        + "(1) stats.messagesAfter <= stats.messagesBefore; "
        + "(2) every tool_use_id in any tool result also appears in some tool use; "
        + "(3) stats.callsDropped + stats.resultsDropped >= 0 and stats.calls >= 0. "
        + "If a check cannot be verified from the output, answer FAIL. "
        + "End your reply with exactly: VERDICT: PASS or VERDICT: FAIL. "
        + "OUTPUT:\n" + compact_out.output,
    #{ label: "verify", capability_mode: "read-only" }
);

let verdict = "";
if verify_out != () && verify_out.success && verify_out.output != () {
    verdict = verify_out.output;
}

let pass = false;
if verdict != "" {
    pass = verdict.contains("VERDICT: PASS");
}

let status = "needs-review";
if pass {
    status = "ok";
}

let verify_val = ();
if verify_out != () {
    verify_val = verify_out.output;
}

complete(#{
    status: status,
    transcript: transcript,
    compact: compact_out.output,
    verify: verify_val,
});
