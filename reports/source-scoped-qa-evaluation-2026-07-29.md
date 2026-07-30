# Source-scoped QA evaluation — 2026-07-29

## Result

Pass. A complete two-source ingestion was performed against a scratch knowledge base
outside the repository:

`/tmp/kb-source-scoped-eval.YEwoYr`

All knowledge-base reads, writes, candidate review, QA, verification, and rendering used
supported `./bin/kb` commands. No direct SQLite query or SQLite client was used. `jq`
was used only to author payload JSON and read CLI JSON envelopes.

## Scenario and identifiers

Source one, `Token Architecture` (`src_e9f8460f6bcb62be`), established:

- Claim `clm_a8f54ebfb0d3fc43`: “The API gateway calls the token service before accepting
  a request.”
- Relationship `rel_f699970ffd57f9be`: API Gateway `calls` Token Service.
- A root → topic → leaf hierarchy, synthesized with the claim and guarded by the
  `bodyHash` returned from each `kb node show --context` read.

Source two, `Token Validation Update` (`src_3b58e28996f5aa05`), added a new evidence
span to both that existing claim and relationship. It also introduced near-duplicate
requirement `clm_66560a49ec86709a`: “The API gateway must call the token service before
accepting every request.”

`kb claim candidates --source` surfaced both claims for review
(`claimsChecked: 2`, `claimsWithCandidates: 2`) and emitted the binding instruction.
The stronger requirement was selected as current:

```text
superseded: clm_a8f54ebfb0d3fc43
by:         clm_66560a49ec86709a
staleNodes: 3
```

After hash-guarded re-synthesis, the finish-stage candidate check returned
`claimsChecked: 1`, `claimsWithCandidates: 0`, with no instruction.

## Commands used

The variables below expand to the actual paths used:

```sh
KB_DIR=/tmp/kb-source-scoped-eval.YEwoYr
EVAL_DIR=<worktree>/.cc/temp/e2e-eval
```

Every `kb` command executed during the evaluation, in order:

```sh
./bin/kb init "$KB_DIR" --json
./bin/kb version --json
./bin/kb status --kb "$KB_DIR" --json
./bin/kb ingest --help --json
./bin/kb node apply --help --json
./bin/kb claim apply --help --json
./bin/kb graph apply --help --json
./bin/kb synthesize --help --json
./bin/kb ingest "$EVAL_DIR/source-one.md" --title "Token Architecture" --source-date 2026-07-01 --dry-run --kb "$KB_DIR" --json
./bin/kb ingest "$EVAL_DIR/source-one.md" --title "Token Architecture" --source-date 2026-07-01 --kb "$KB_DIR" --json
./bin/kb source chunks src_e9f8460f6bcb62be --kb "$KB_DIR" --json
./bin/kb node apply --file "$EVAL_DIR/hierarchy.json" --dry-run --kb "$KB_DIR" --json
./bin/kb node apply --file "$EVAL_DIR/hierarchy.json" --kb "$KB_DIR" --json
./bin/kb claim apply --file "$EVAL_DIR/claims-one.json" --dry-run --kb "$KB_DIR" --json
./bin/kb claim apply --file "$EVAL_DIR/claims-one.json" --kb "$KB_DIR" --json
./bin/kb vocabulary list --kb "$KB_DIR" --json
./bin/kb graph apply --file "$EVAL_DIR/graph-one.json" --dry-run --kb "$KB_DIR" --json
./bin/kb graph apply --file "$EVAL_DIR/graph-one.json" --kb "$KB_DIR" --json
./bin/kb node show nod_2725fd9f1f4b3708 --context --kb "$KB_DIR" --json
./bin/kb node show nod_081153b4e4c175b6 --context --kb "$KB_DIR" --json
./bin/kb node show nod_26cead3a4de9b191 --context --kb "$KB_DIR" --json
./bin/kb synthesize --file "$EVAL_DIR/synthesize-one.json" --dry-run --kb "$KB_DIR" --json
./bin/kb synthesize --file "$EVAL_DIR/synthesize-one.json" --kb "$KB_DIR" --json
./bin/kb ingest "$EVAL_DIR/source-two.md" --title "Token Validation Update" --source-date 2026-07-15 --dry-run --kb "$KB_DIR" --json
./bin/kb ingest "$EVAL_DIR/source-two.md" --title "Token Validation Update" --source-date 2026-07-15 --kb "$KB_DIR" --json
./bin/kb source chunks src_3b58e28996f5aa05 --kb "$KB_DIR" --json
./bin/kb claim apply --file "$EVAL_DIR/claims-two.json" --dry-run --kb "$KB_DIR" --json
./bin/kb claim apply --file "$EVAL_DIR/claims-two.json" --kb "$KB_DIR" --json
./bin/kb graph apply --file "$EVAL_DIR/graph-two.json" --dry-run --kb "$KB_DIR" --json
./bin/kb graph apply --file "$EVAL_DIR/graph-two.json" --kb "$KB_DIR" --json
./bin/kb claim candidates --source src_3b58e28996f5aa05 --kb "$KB_DIR" --json
./bin/kb claim supersede clm_a8f54ebfb0d3fc43 --by clm_66560a49ec86709a --kb "$KB_DIR" --json
./bin/kb node show nod_2725fd9f1f4b3708 --context --kb "$KB_DIR" --json
./bin/kb node show nod_081153b4e4c175b6 --context --kb "$KB_DIR" --json
./bin/kb node show nod_26cead3a4de9b191 --context --kb "$KB_DIR" --json
./bin/kb synthesize --file "$EVAL_DIR/synthesize-two.json" --dry-run --kb "$KB_DIR" --json
./bin/kb synthesize --file "$EVAL_DIR/synthesize-two.json" --kb "$KB_DIR" --json
./bin/kb claim candidates --source src_3b58e28996f5aa05 --kb "$KB_DIR" --json
./bin/kb coverage --source src_3b58e28996f5aa05 --kb "$KB_DIR" --json
./bin/kb relationship list --source src_3b58e28996f5aa05 --kb "$KB_DIR" --json
./bin/kb verify --strict --kb "$KB_DIR" --json
./bin/kb render --kb "$KB_DIR" --json
./bin/kb render --check --kb "$KB_DIR" --json
```

Every authored payload was previewed with `--dry-run` and then applied unchanged.

## Scoped coverage result

`kb coverage --source src_3b58e28996f5aa05 --json` returned `ok: true` with
`membership: "evidence-span"`:

```json
{
  "chunks": {
    "total": 1,
    "substantive": 1,
    "cited": 1,
    "uncited": { "total": 0, "shown": 0, "ids": [] }
  },
  "claims": {
    "active": {
      "total": 1,
      "synthesized": 1,
      "unsynthesized": { "total": 0, "shown": 0, "ids": [] }
    },
    "conflicted": { "total": 0, "shown": 0, "ids": [] },
    "superseded": {
      "total": 1,
      "shown": 1,
      "ids": ["clm_a8f54ebfb0d3fc43"]
    },
    "retracted": { "total": 0, "shown": 0, "ids": [] }
  },
  "relationships": {
    "total": 1,
    "byStatus": {
      "active": 1,
      "superseded": 0,
      "conflicted": 0,
      "retracted": 0
    }
  },
  "candidates": { "total": 0, "shown": 0, "claimIds": [] },
  "findings": {
    "SOURCE_NO_CLAIMS": 0,
    "CHUNK_UNCITED": 0,
    "CLAIM_NOT_SYNTHESIZED": 0,
    "OPEN_QUESTION_NOT_SYNTHESIZED": 0
  }
}
```

The scoped result is clean. The superseded claim is retained as reviewed historical
inventory and does not create a synthesis gap. No finding needed explicit acceptance.

## Relationship contribution evidence

`kb relationship list --source src_3b58e28996f5aa05 --json` returned the relationship
first seen in source one and both live evidence links:

```json
{
  "id": "rel_f699970ffd57f9be",
  "type": "calls",
  "firstSeenSource": {
    "id": "src_e9f8460f6bcb62be",
    "title": "Token Architecture"
  },
  "evidence": [
    {
      "sourceId": "src_3b58e28996f5aa05",
      "sourceTitle": "Token Validation Update",
      "quote": "The API gateway calls the token service before accepting a request.",
      "matchesSourceScope": true
    },
    {
      "sourceId": "src_e9f8460f6bcb62be",
      "sourceTitle": "Token Architecture",
      "quote": "The API gateway calls the token service before accepting a request.",
      "matchesSourceScope": false
    }
  ]
}
```

Totals were `relationships: 1`, `evidenceLinks: 2`, and
`matchingEvidenceLinks: 1`.

## Terminal gates

- `kb verify --strict`: `ok: true`, `errors: 0`, `warnings: 0`, `findings: []`.
- `kb render`: `ok: true`, `written: 8`.
- `kb render --check`: `ok: true`, `checked: 8`, `drift: []`.

The evaluation required zero direct SQLite access for source-scoped QA or any other
step.
