import test from "node:test";
import assert from "node:assert/strict";
import { assertDeploymentIdentity } from "../src/deployment-identity";
const identity = { sourceSha: "a".repeat(40), imageBuildId: "b".repeat(64), mode: "off", writerEpoch: "1" };
const env = { FEED_ENVIRONMENT: "production", FEED_RELEASE_SHA: identity.sourceSha, FEED_IMAGE_BUILD_ID: identity.imageBuildId, FEED_MODE: "off", FEED_WRITER_EPOCH: "1" };
test("production constructors require compiled identity matching every release field", () => {
  assert.doesNotThrow(() => assertDeploymentIdentity(env, identity));
  assert.throws(() => assertDeploymentIdentity(env), /runtime_deployment_identity_mismatch/);
  for (const changed of [null, {}, {...identity, extra: true}, {...identity, mode: "baseline"}, {...identity, sourceSha: "c".repeat(40)}, {...identity, imageBuildId: "d".repeat(64)}, {...identity, writerEpoch: "2"}])
    assert.throws(() => assertDeploymentIdentity(env, changed), /runtime_deployment_identity_mismatch/);
  assert.doesNotThrow(() => assertDeploymentIdentity({...env, FEED_MODE: "baseline"}, {...identity, mode: "baseline"}));
});
test("uncompiled local staging remains usable but a supplied mismatched identity is rejected", () => {
  assert.doesNotThrow(() => assertDeploymentIdentity({...env, FEED_ENVIRONMENT: "staging"}));
  assert.throws(() => assertDeploymentIdentity({...env, FEED_ENVIRONMENT: "staging"}, {...identity, mode: "baseline"}));
});
test("writer epoch accepts matching positive safe integers and rejects noncanonical or unsafe values", () => {
  assert.doesNotThrow(() => assertDeploymentIdentity({...env, FEED_WRITER_EPOCH: "2"}, {...identity, writerEpoch: "2"}));
  assert.throws(() => assertDeploymentIdentity(env, {...identity, writerEpoch: "2"}), /runtime_deployment_identity_mismatch/);
  for (const writerEpoch of ["0", "-1", "01", "9007199254740992", "1.0", "1e2"])
    assert.throws(() => assertDeploymentIdentity({...env, FEED_WRITER_EPOCH: writerEpoch}, {...identity, writerEpoch}), /runtime_deployment_identity_mismatch/);
  assert.doesNotThrow(() => assertDeploymentIdentity({...env, FEED_WRITER_EPOCH: "9007199254740991"}, {...identity, writerEpoch: "9007199254740991"}));
});
