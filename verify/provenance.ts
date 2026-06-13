/* Live provenance + content-credentials + content-CI verification. Real sqlite kernel,
 * drafts + signing + evals + an agent principal + audit. Run: pnpm tsx verify/provenance.ts
 *
 * Proves: the provenance chain surfaces human author + agent contributor + approver;
 * sign-on-publish then detect-tamper-on-verify; a different secret does not verify;
 * blocking evals reject a publish (doc stays draft) and pass once fixed; an agent page
 * that fails content CI can't be approved until fixed; and no key material ever leaks.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, policyEval, seoEval, CREDENTIALS_TABLE } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const editor = { req: { user: { id: 'ed', roles: ['editor'] } } }
const author = { req: { user: { id: 'alice', roles: ['editor'] } } }
const agentReq = {
  req: { user: { id: 'bot', principalType: 'agent' as const, roles: [], fieldScope: { allow: ['title', 'body'] } } },
}

const SECRET_A = 'verify-content-credential-secret-A'
const SECRET_B = 'verify-content-credential-secret-B'

function buildConfig(dbFile: string, secret: string, evals: any[]) {
  return defineConfig({
    secret: 'verify-provenance-secret-32-chars!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    signing: { secret },
    evals,
    agents: [{ id: 'bot', token: 'bot-token-verify-provenance', roles: [], fieldScope: { allow: ['title', 'body'] } }],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'text' },
        ],
      },
    ],
  })
}

const tmp = (n: string) => join(mkdtempSync(join(tmpdir(), `kverify-prov-${n}-`)), 'p.db')

async function main() {
  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mProvenance — human author + agent contributor + approver\x1b[0m')
  const k = await initKernel(buildConfig(tmp('a'), SECRET_A, []), { autoMigrate: true })

  const post = await k.create({ collection: 'posts', data: { title: 'First draft' }, ...author })
  await k.update({ collection: 'posts', id: post.id, data: { body: 'agent revision' }, ...agentReq })
  await k.publish({ collection: 'posts', id: post.id, ...editor })

  const prov = await k.provenance({ collection: 'posts', id: post.id, ...editor })
  check('chain has 3 versions (create, agent edit, publish)', prov.chain.length === 3, `len=${prov.chain.length}`)
  check(
    'createdBy is the human author',
    prov.createdBy?.id === 'alice' && prov.createdBy?.type === 'user',
    `${prov.createdBy?.id}/${prov.createdBy?.type}`,
  )
  check(
    'contributors include the agent (type:agent)',
    prov.contributors.some((c) => c.id === 'bot' && c.type === 'agent'),
    `contributors=${prov.contributors.map((c) => `${c.id}:${c.type}`).join(',')}`,
  )
  check(
    'contributors include the human (type:user)',
    prov.contributors.some((c) => c.id === 'alice' && c.type === 'user'),
  )
  const published = prov.chain.find((c) => c.status === 'published')
  check(
    'published version records the approver (the editor)',
    published?.approver?.id === 'ed' && published?.approver?.type === 'user',
    `approver=${published?.approver?.id}/${published?.approver?.type}`,
  )

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mContent credentials — sign on publish, detect tampering on verify\x1b[0m')
  const ok = await k.verifyContentCredential({ collection: 'posts', id: post.id, ...editor })
  check('freshly published doc verifies valid:true', ok.valid === true, `reason=${ok.reason ?? '-'}`)

  const cred = await k.getContentCredential({ collection: 'posts', id: post.id, ...editor })
  check('a credential row exists with the alg label', cred?.algorithm === 'hmac-sha256', `alg=${cred?.algorithm}`)

  // Tamper: mutate the published row directly via the adapter (bypassing the engine).
  await k.db.update({ collection: 'posts', id: post.id, data: { body: 'TAMPERED CONTENT' } })
  const tampered = await k.verifyContentCredential({ collection: 'posts', id: post.id, ...editor })
  check(
    'tampered doc verifies valid:false with a tamper reason',
    tampered.valid === false && /modified|hash mismatch/i.test(tampered.reason ?? ''),
    `valid=${tampered.valid} reason=${tampered.reason}`,
  )

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mContent credentials — a different secret does not verify\x1b[0m')
  // Boot a SECOND kernel with a DIFFERENT signing secret (B). It signs its own credential
  // under B; that credential must NOT verify under A's signer (the wrong-key guarantee).
  const kB = await initKernel(buildConfig(tmp('b'), SECRET_B, []), { autoMigrate: true })
  const freshB = await kB.create({ collection: 'posts', data: { title: 'B doc' }, ...author })
  await kB.publish({ collection: 'posts', id: freshB.id, ...editor })
  const kBcred = await kB.getContentCredential({ collection: 'posts', id: freshB.id, ...editor })
  // Under kB's own (secret-B) signer the credential verifies; under an A signer it must fail.
  const selfOk = await kB.verifyContentCredential({ collection: 'posts', id: freshB.id, ...editor })
  check('kB verifies its own credential under secret B', selfOk.valid === true)
  const { verifyManifest, createSigner } = await import('@kernel/core')
  const signerA = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: SECRET_A })!
  const resWrongKey = verifyManifest(signerA, kBcred!.manifest, kBcred!.signature)
  check(
    'manifest signed under secret B does NOT verify under secret A',
    resWrongKey.valid === false && /signature/i.test(resWrongKey.reason ?? ''),
    `valid=${resWrongKey.valid} reason=${resWrongKey.reason}`,
  )
  await kB.destroy()

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mContent CI — a blocking eval rejects publish; passes once fixed\x1b[0m')
  const kc = await initKernel(
    buildConfig(tmp('c'), SECRET_A, [
      policyEval({ bannedTerms: ['scandal'] }),
      seoEval({ titleField: 'title', minTitle: 3, maxTitle: 40 }),
    ]),
    { autoMigrate: true },
  )
  const bad = await kc.create({ collection: 'posts', data: { title: 'A juicy scandal' }, ...author })
  let rejected = false
  let rejErr: any = null
  try {
    await kc.publish({ collection: 'posts', id: bad.id, ...editor })
  } catch (e: any) {
    rejected = true
    rejErr = e
  }
  check('publish with a banned term is REJECTED', rejected, rejErr?.code ?? '')
  check(
    'rejection carries the eval finding',
    /scandal|banned/i.test(JSON.stringify(rejErr?.errors ?? rejErr?.message ?? '')),
    '',
  )
  const stillDraft = await kc.findByID({ collection: 'posts', id: bad.id, draft: true, ...editor })
  check(
    'the doc stays a draft after a rejected publish',
    stillDraft?._status === 'draft',
    `status=${stillDraft?._status}`,
  )
  const noCred = await kc.getContentCredential({ collection: 'posts', id: bad.id, ...editor })
  check('no credential was written for the rejected publish', noCred === null)

  // Fix the content -> publish succeeds.
  await kc.update({ collection: 'posts', id: bad.id, data: { title: 'A clean headline' }, ...editor })
  const good = await kc.publish({ collection: 'posts', id: bad.id, ...editor })
  check('publish succeeds once the content is fixed', good?._status === 'published', `status=${good?._status}`)
  const fixedCred = await kc.verifyContentCredential({ collection: 'posts', id: bad.id, ...editor })
  check('the now-published doc verifies valid:true', fixedCred.valid === true)

  // Non-blocking warn does not block but is recorded in the audit meta.
  const warnK = await initKernel(
    buildConfig(tmp('warn'), SECRET_A, [
      { name: 'soft', blocking: false, run: () => [{ ok: false, severity: 'warn' as const, message: 'soft warning' }] },
    ]),
    { autoMigrate: true },
  )
  const wp = await warnK.create({ collection: 'posts', data: { title: 'Warns only' }, ...author })
  const wpub = await warnK.publish({ collection: 'posts', id: wp.id, ...editor })
  check('a non-blocking warn does NOT block the publish', wpub?._status === 'published')
  const auditWarn = await warnK.findAuditLog({ where: { action: { equals: 'publish' } } })
  const meta = (auditWarn.docs[0]?.meta as any)?.evalFindings
  check(
    'the non-blocking warn is recorded in the audit meta',
    Array.isArray(meta) && meta.some((m: any) => /soft warning/i.test(m.message)),
    `meta=${JSON.stringify(meta)}`,
  )
  await warnK.destroy()

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mAgent + content CI + review — cannot approve until fixed\x1b[0m')
  const ka = await initKernel(buildConfig(tmp('agent'), SECRET_A, [policyEval({ bannedTerms: ['scandal'] })]), {
    autoMigrate: true,
  })
  const agentPage = await ka.create({ collection: 'posts', data: { title: 'agent scandal piece' }, ...agentReq })
  let approveBlocked = false
  try {
    await ka.submitReview({ collection: 'posts', id: agentPage.id, decision: 'approve', ...editor })
  } catch {
    approveBlocked = true
  }
  check('an agent page violating content CI cannot be approved', approveBlocked)
  const agentDraft = await ka.findByID({ collection: 'posts', id: agentPage.id, draft: true, ...editor })
  check('it stays a draft', agentDraft?._status === 'draft', `status=${agentDraft?._status}`)
  await ka.update({ collection: 'posts', id: agentPage.id, data: { title: 'agent clean piece' }, ...editor })
  const approved = await ka.submitReview({ collection: 'posts', id: agentPage.id, decision: 'approve', ...editor })
  check('once fixed, the reviewer can approve -> publish', approved.decision === 'approved')
  const live = await ka.findByID({ collection: 'posts', id: agentPage.id, ...editor })
  check('the approved agent page is now published', live?._status === 'published')
  // The published agent page's credential records the editor (reviewer) as approver.
  const agentProv = await ka.provenance({ collection: 'posts', id: agentPage.id, ...editor })
  const agentPub = agentProv.chain.find((c) => c.status === 'published')
  check(
    'approver on the published agent page is the reviewer',
    agentPub?.approver?.id === 'ed',
    `approver=${agentPub?.approver?.id}`,
  )

  // ---------------------------------------------------------------------------
  // F-1: scheduled & override publishes must NOT bypass blocking pre-publish evals.
  console.log('\n\x1b[1mContent CI — scheduled & override publishes cannot bypass a blocking eval\x1b[0m')
  const kf = await initKernel(buildConfig(tmp('f1'), SECRET_A, [policyEval({ bannedTerms: ['scandal'] })]), {
    autoMigrate: true,
  })

  // (a) A doc that FAILS a blocking eval, SCHEDULED via publish({ publishAt: past }), then
  //     run through processScheduledPublishes → stays a DRAFT, reported as skipped, NO credential.
  const schedBad = await kf.create({ collection: 'posts', data: { title: 'scheduled scandal' }, ...author })
  // Schedule in the future first (an immediate publishAt would publish synchronously and be
  // rejected here); then process with a `now` past the scheduled time so it becomes due.
  const future = new Date(Date.now() + 60_000).toISOString()
  await kf.publish({ collection: 'posts', id: schedBad.id, publishAt: future, ...editor })
  const beforeRun = await kf.findByID({ collection: 'posts', id: schedBad.id, draft: true, ...editor })
  check('scheduled eval-failing doc is a draft before the scheduler runs', beforeRun?._status === 'draft')
  const runRes = await kf.processScheduledPublishes({ now: new Date(Date.now() + 120_000).toISOString() })
  check(
    'processScheduledPublishes does NOT report the eval-failing doc as published',
    !runRes.published.includes(schedBad.id),
    `published=${JSON.stringify(runRes.published)}`,
  )
  check(
    'processScheduledPublishes reports it as skipped with a reason',
    Array.isArray(runRes.skipped) &&
      runRes.skipped.some((s) => s.id === schedBad.id && /scandal|banned|\w/.test(s.reason)),
    `skipped=${JSON.stringify(runRes.skipped)}`,
  )
  const afterRun = await kf.findByID({ collection: 'posts', id: schedBad.id, draft: true, ...editor })
  check(
    'the eval-failing scheduled doc STAYS a draft after the scheduler runs',
    afterRun?._status === 'draft',
    `status=${afterRun?._status}`,
  )
  const schedNoCred = await kf.getContentCredential({ collection: 'posts', id: schedBad.id, ...editor })
  check('NO content credential was written for the eval-failing scheduled publish', schedNoCred === null)

  // (b) A direct update({ _status:'published', overrideAccess:true }) on an eval-failing doc
  //     → REJECTED, stays draft, no credential.
  const ovrBad = await kf.create({ collection: 'posts', data: { title: 'override scandal' }, ...author })
  let ovrRejected = false
  try {
    await kf.update({
      collection: 'posts',
      id: ovrBad.id,
      data: { _status: 'published' },
      overrideAccess: true,
    })
  } catch {
    ovrRejected = true
  }
  check('a direct overrideAccess publish of an eval-failing doc is REJECTED', ovrRejected)
  const ovrAfter = await kf.findByID({ collection: 'posts', id: ovrBad.id, draft: true, ...editor })
  check(
    'the override-published eval-failing doc stays a draft',
    ovrAfter?._status === 'draft',
    `status=${ovrAfter?._status}`,
  )
  const ovrNoCred = await kf.getContentCredential({ collection: 'posts', id: ovrBad.id, ...editor })
  check('NO content credential was written for the rejected override publish', ovrNoCred === null)

  // (c) A scheduled publish that PASSES evals → publishes AND gets a valid signed credential.
  const schedGood = await kf.create({ collection: 'posts', data: { title: 'clean scheduled post' }, ...author })
  await kf.publish({ collection: 'posts', id: schedGood.id, publishAt: future, ...editor })
  const runGood = await kf.processScheduledPublishes({ now: new Date(Date.now() + 120_000).toISOString() })
  check('a clean scheduled doc IS published by the scheduler', runGood.published.includes(schedGood.id))
  const schedGoodLive = await kf.findByID({ collection: 'posts', id: schedGood.id, ...editor })
  check('the clean scheduled doc is now published', schedGoodLive?._status === 'published')
  const schedGoodCred = await kf.verifyContentCredential({ collection: 'posts', id: schedGood.id, ...editor })
  check(
    'the clean scheduled publish got a valid signed credential',
    schedGoodCred.valid === true,
    `reason=${schedGoodCred.reason ?? '-'}`,
  )
  await kf.destroy()

  // ---------------------------------------------------------------------------
  // F-2: a pathologically deep stored doc must not crash verify with a stack overflow.
  console.log('\n\x1b[1mContent credentials — a pathologically deep doc does not crash verify\x1b[0m')
  const kd = await initKernel(buildConfig(tmp('deep'), SECRET_A, []), { autoMigrate: true })
  const deepDoc = await kd.create({ collection: 'posts', data: { title: 'deep doc' }, ...author })
  await kd.publish({ collection: 'posts', id: deepDoc.id, ...editor })
  // Build a >100-deep nested object and write it directly into the stored row (bypassing the
  // engine), mimicking a malformed/over-deep persisted document at verify time.
  let nested: Record<string, unknown> = { leaf: true }
  for (let i = 0; i < 300; i++) nested = { child: nested }
  await kd.db.update({ collection: 'posts', id: deepDoc.id, data: { body: nested } })
  let deepThrew = false
  let deepRes: any = null
  try {
    deepRes = await kd.verifyContentCredential({ collection: 'posts', id: deepDoc.id, ...editor })
  } catch {
    deepThrew = true
  }
  check('verifyContentCredential on a deep doc does NOT throw an uncaught stack overflow', !deepThrew)
  check(
    'verifyContentCredential on a deep doc returns valid:false',
    deepThrew === false && deepRes?.valid === false,
    `valid=${deepRes?.valid} reason=${deepRes?.reason}`,
  )
  // And the low-level canonicalJSON enforces the cap with the typed error.
  const { canonicalJSON, CanonicalDepthError } = await import('@kernel/core')
  let depthErr = false
  try {
    canonicalJSON(nested)
  } catch (e) {
    depthErr = e instanceof CanonicalDepthError
  }
  check('canonicalJSON throws a typed CanonicalDepthError past the depth cap', depthErr)
  await kd.destroy()

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mSecurity — the signing secret never leaks\x1b[0m')
  const credRow = await k.db.find({ collection: CREDENTIALS_TABLE, limit: 50, page: 1 })
  const provOut = await k.provenance({ collection: 'posts', id: post.id, ...editor })
  const credOut = await k.getContentCredential({ collection: 'posts', id: post.id, ...editor })
  const verifyOut = await k.verifyContentCredential({ collection: 'posts', id: post.id, ...editor })
  let leakErr = ''
  try {
    await k.verifyContentCredential({ collection: 'nope', id: 'x', ...editor })
  } catch (e: any) {
    leakErr = JSON.stringify({ message: e?.message, details: e?.details })
  }
  const surface = JSON.stringify({ credRow, provOut, credOut, verifyOut, leakErr })
  check('SECRET_A never appears in any credential/manifest/provenance/error output', !surface.includes(SECRET_A))
  check('SECRET_A never appears in the raw _credentials rows', !JSON.stringify(credRow).includes(SECRET_A))

  await k.destroy()
  await kc.destroy()
  await ka.destroy()

  console.log(`\n\x1b[1mProvenance Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('PROVENANCE HARNESS ERROR:', e)
  process.exit(2)
})
