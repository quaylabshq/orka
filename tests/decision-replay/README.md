# Replay skill merge decisions

The frozen synthetic inputs cover 20 skill cases and one publish-permission control. The native backtest runs the skill materializer and publish queue against disposable installed copies and SQLite. It reports the exact queued, installed or privately staged candidate. A queued change still needs an accepted server receipt in the product.

Run from the repository root after installing the desktop dependencies.

```sh
work=$(mktemp -d)
export ORKA_SKILL_BACKTEST_INPUT="$PWD/tests/decision-replay/skills.json"
export ORKA_SKILL_BACKTEST_OUTPUT="$work/native.json"
cargo test --locked --manifest-path apps/mac/src-tauri/Cargo.toml \
  skill_decision_backtest -- --ignored --test-threads=1
node tests/decision-replay/skills.mjs "$work/native.json"
```

For the JEV experiment, supply a server-side JEV fixture credential in the environment and run the following command on the same synthetic output.

```sh
node tests/decision-replay/skills.mjs "$work/native.json" --live
```

The offline result scores deterministic queued or installed bytes against acceptable complete documents. In the optional live run, JEV sees only synthetic inputs and the exact two-sided candidate that native reconciliation placed in review. The scorer gives credit for a model-approved candidate only when it matches the fixture's accepted result. The app never sends skill bodies to JEV as part of this feature. A failed provider request stays unresolved and causes the replay to exit unsuccessfully.
