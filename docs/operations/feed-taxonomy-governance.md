# Feed taxonomy operations

The initial operations target is isolated staging. The API and executor never
receive the Cloudflare operator credential. The public gateway can submit a
proposal; only the separate protected capability can review it. Existing pending
proposals remain pending unless an operator reviews that exact identifier.

The workflow `Feed staging taxonomy operation` requires the exact deployed SHA,
successful CI, current resource/Worker/image readback, and an actually protected
`Feed staging operations` environment. Its concurrency group also serializes with
recovery operations. The repository currently has no verified protection setup;
the workflow refuses execution until that is fixed. Merging this code does not
enable a production governance target.

First query `proposal` with the exact `proposalKind` and `proposalId`. This is a
public repository: Actions artifacts retain only the proposal identity and a
content hash, never raw evidence or review reasons. Inspect the full private
capability response through an authorized local operator client. The CLI's
explicit `--private-proposal path` option writes it to a new local mode-0600 file;
the Actions workflow does not enable that option. Review the assessment
identifier, evidence, current eligibility and taxonomy version before writing.
For `review`, provide the frozen governance-v1 body with
an explicit command UUID, writer epoch, expected taxonomy/analysis, action and
reason. Create/map require explicit weight and confidence; create also requires
labels. The workflow assigns `operator` from the authenticated GitHub actor and
rejects a conflicting supplied actor. It cannot bulk approve, set arbitrary
project evidence or silently rename a target. Deprecation names one canonical tag
and preserves historical references; it does not migrate preferences implicitly.

Each execution performs three account/resource reads and one runtime health read
before sending privileged headers. A mutation then performs one receipt read,
one write attempt and one receipt read, with no automatic retry. Responses are
bounded, secrets stay in headers, and the mutation artifact contains a reason
hash instead of its text. The database audit retains the reviewer and reason.
Sanitized operation artifacts are retained for 30 days. Environment protection
controls execution approval; it does not provide an artifact access boundary.

If the write response is lost, the run reports `uncertain`, even if the receipt
readback confirms a committed command. Retry only the same command UUID and exact
body, or query `command` first. An existing receipt is not permission to skip
payload validation: a retry still makes at most one store command so its immutable
payload hash is checked. Changed content returns a conflict. Never issue a fresh
UUID just to clear an uncertain result. An accepted governance command reports
taxonomy application, not completion of asynchronous project reevaluation.

The operation artifact records both the original Actions requester and the actual
run trigger, plus run ID and attempt. On reruns the original command's reviewer
identity remains unchanged for idempotency; it must not be presented as evidence
that the original requester personally triggered the new attempt.

Alias mapping affects subsequent governed resolution in that namespace. It does
not approve other pending proposals. Existing alias conflicts and stale evidence
are rejected. The active taxonomy version invalidates old sessions and behavior
request writes without updating every user row. Deprecated tags stop acting as
canonical positive or negative preferences; historical evidence remains intact.

User proposals are private contributions associated with a profile generation.
Deleting that generation immediately hides their inspection response and fences
new reviews; waiting for asynchronous cleanup is not an authorization boundary.
Recreating the same GitHub user's profile does not restore a previous proposal.
New proposal commands belong to one actor and generation, so two users proposing
the same project/tag do not acquire each other's proposal or evidence.

A review of a deleted or unattributable user proposal returns
`409 governance_proposal_deleted`; inspection returns `{"proposal":null}`. An
already committed governance command can still return its original safe receipt
on an exact retry, without copying or recreating content. A changed retry remains
a conflict. The reviewed canonical definition, alias and public classification
can remain as independently moderated project facts. The original user's labels
and evidence are erased from the proposal, and raw evidence previously copied
into an assignment is erased only while that assignment still names the original
proposal. A later assignment by another reviewer must survive that cleanup.
New user-derived assignments store a controlled `governance:<commandId>` reference
instead of the user's raw evidence. Only minimal hashes, deletion fences and safe
receipts remain for replay prevention; author associations are removed after all
their content sinks have been cleaned. Cleanup cannot report completed before
this work, archive erasure and any required index erasure finish.

The implementation gate includes deletion before review, deletion after review,
deletion concurrent with review, repeated cleanup, replacement assignments and a
new profile generation, against both real storage profiles. A snapshot produced
before the deletion must receive the current deletion overlay before use. A
schema 7 or 9 recovery report does not establish this later privacy migration's
recovery behavior.

The transport contract number and additive SQL compatibility range do not prove
that an old implementation supports these taxonomy semantics. After governance
is used, an allowed application rollback must retain the lazy taxonomy fences.
Stage 5 must register and exercise that compatible implementation SHA window;
rolling the adapter back to a pre-governance implementation is not an approved
rollback. No operator command, taxonomy promotion, production activation or
protected-environment setup is established by local tests alone.
