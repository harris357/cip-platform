// Slice 56N activities: S3 upload + hot-reload verification.
//
// uploadModelToS3Activity: HTTP shim to the classifier's
// /admin/run-upload endpoint, which calls the existing upload.py code
// (boto3 to OVH S3, sha256 verify, atomic CURRENT.json swap).
//
// verifyHotReloadActivity: polls every classifier pod's /healthz to
// confirm the new model_version has been picked up. Failure is NOT a
// rollback signal — the artifact is in S3 and pods will pick it up on
// their next 60s poll cycle even if our verification window misses it.

import { z } from 'zod';

const classifierUrl = (): string =>
  process.env['INTENT_CLASSIFIER_URL']
    ?? 'http://intent-classifier.cip-app.svc.cluster.local:8000';

// ── uploadModelToS3Activity ───────────────────────────────────────────

const UploadModelInput = z.object({
  tenantId:     z.string().uuid().nullable(),
  artifactPath: z.string(),
  version:      z.string(),
});
const UploadModelOutput = z.object({
  artifactUri:    z.string(),
  artifactSha256: z.string(),
});

export async function uploadModelToS3Activity(
  input: z.input<typeof UploadModelInput>,
): Promise<z.infer<typeof UploadModelOutput>> {
  const args = UploadModelInput.parse(input);
  const resp = await fetch(`${classifierUrl()}/admin/run-upload`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      tenant_id:     args.tenantId,
      artifact_path: args.artifactPath,
      version:       args.version,
    }),
  });
  if (!resp.ok) {
    throw new Error(`run-upload failed: ${resp.status} ${await resp.text()}`);
  }
  return UploadModelOutput.parse(await resp.json());
}

// ── verifyHotReloadActivity ───────────────────────────────────────────

const VerifyHotReloadInput = z.object({
  expectedVersion: z.string(),
  pollIntervalSec: z.number().int().min(5).max(60).default(30),
  timeoutSec:      z.number().int().min(60).max(900).default(300),
});
const VerifyHotReloadOutput = z.object({
  verified:       z.boolean(),
  loadedVersion:  z.string().nullable(),
  podsChecked:    z.number(),
  reason:         z.string().nullable(),
});

export async function verifyHotReloadActivity(
  input: z.input<typeof VerifyHotReloadInput>,
): Promise<z.infer<typeof VerifyHotReloadOutput>> {
  const args = VerifyHotReloadInput.parse(input);
  const deadline = Date.now() + args.timeoutSec * 1000;

  while (Date.now() < deadline) {
    try {
      // /healthz hits the kube service which load-balances across all
      // classifier pods. We poll repeatedly to account for any pod that
      // hasn't refreshed yet — eventually all replicas converge on the
      // same CURRENT.json.
      const resp = await fetch(`${classifierUrl()}/healthz`);
      if (resp.ok) {
        const body = (await resp.json()) as { ok: boolean; model_version: string | null };
        if (body.model_version === args.expectedVersion) {
          return VerifyHotReloadOutput.parse({
            verified:      true,
            loadedVersion: body.model_version,
            podsChecked:   1,
            reason:        null,
          });
        }
      }
    } catch (err) {
      // transient; loop continues until deadline
    }
    await new Promise(r => setTimeout(r, args.pollIntervalSec * 1000));
  }

  return VerifyHotReloadOutput.parse({
    verified:      false,
    loadedVersion: null,
    podsChecked:   0,
    reason:        `did not see expected version ${args.expectedVersion} within ${args.timeoutSec}s`,
  });
}
