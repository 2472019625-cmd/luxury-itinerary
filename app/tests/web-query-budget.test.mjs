import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { applyKnowledgeSourcePathEvidence, failedHardRequirement, runImageSearchSkill } from '../server/simple-image-skill.mjs';

const slot = {
  slotId: 'query-budget', moduleType: 'day', required: true, userLocked: false,
  subject: '角马群', visualGoal: '角马渡河', visualContext: {}, copyTargetId: 'copy:day:1', aspectRatio: '16:9',
  location: 'Kenya', country: 'Kenya', exactIdentityRequired: false,
  queryCore: { subject: '角马群', subjectEn: 'wildebeest herd', action: '渡河', actionEn: 'river crossing' },
  fidelityQuery: '角马渡河', alternateQueries: ['wildebeest herd river crossing'],
};

const judgment = (candidate, good) => ({
  candidateId: candidate.candidateId, actualSubject: good ? '角马渡河' : '无关主体', reason: '受控审核',
  matchLevel: good ? 'exact' : 'mismatch', locationMatch: true, visibleLocationConflict: false,
  hotelIdentityMatch: true, visibleIdentityConflict: false, activityMatch: good, coreActionMatch: good,
  subjectMatch: good, coreSubjectMatch: good, identityMatch: true, subjectClear: true,
  subjectLargeEnough: true, subjectPrimary: true, transportType: 'none', transportTypeMatch: true,
  watermarkFree: true, nonAI: true, photographic: true, technicalUsable: true,
  eligible: good, hardRejectCode: good ? 'none' : 'wrong_subject',
  relevance: good ? 95 : 20, luxury: 90, cleanliness: 90, composition: 90, score: good ? 95 : 20,
});

test('新版必要身份证据不足保持人工状态；已核验实体路径可提供确定性身份依据', () => {
  const target = { ...slot, moduleType: 'hotel', hotel: 'Fixture Hotel', exactIdentityRequired: true, queryCore: { subject: '客房', identity: 'Fixture Hotel' } };
  const audit = {
    ...judgment({ candidateId: 'identity-fixture' }, true), auditEvidenceVersion: 2,
    eligible: false, identityMatch: false, hotelIdentityMatch: false,
    identityEvidence: { status: 'insufficient', basis: 'none', evidenceIds: [], explanation: '没有身份依据' },
  };
  assert.equal(failedHardRequirement(target, audit), 'needs_user_judgment');
  assert.equal(failedHardRequirement(target, { ...audit, hardRejectCode: 'wrong_activity' }), 'wrong_activity');
  assert.equal(failedHardRequirement(target, { ...audit, watermarkFree: false }), 'watermark');
  assert.equal(failedHardRequirement(target, { ...audit, visibleIdentityConflict: true, hardRejectCode: 'wrong_hotel' }), 'wrong_hotel');
  const confirmed = applyKnowledgeSourcePathEvidence(target, audit, { match: true, mode: 'entity_identity', scopePath: 'Kenya/Fixture Hotel' });
  assert.equal(confirmed.identityEvidence.status, 'supported');
  assert.equal(confirmed.identityEvidence.basis, 'knowledge_path');
  assert.equal(confirmed.identityMatch, true);
  assert.equal(failedHardRequirement(target, confirmed), null);
  const conflicting = applyKnowledgeSourcePathEvidence(target, audit, { match: false, mode: 'entity_identity', scopePath: 'Kenya/Other Hotel' });
  assert.equal(failedHardRequirement(target, conflicting), 'wrong_hotel');
});

test('已核验知识库目录不覆盖v2逐图身份冲突或身份硬拒，旧版路径行为保持兼容', () => {
  const target = { ...slot, moduleType: 'hotel', hotel: 'Fixture Hotel', exactIdentityRequired: true, queryCore: { subject: '客房', identity: 'Fixture Hotel' } };
  const pathDecision = { match: true, mode: 'entity_identity', scopePath: 'Kenya/Fixture Hotel' };
  const conflicting = {
    ...judgment({ candidateId: 'caption-conflict' }, true), auditEvidenceVersion: 2,
    eligible: false, identityMatch: false, hotelIdentityMatch: false,
    hardRejectCode: 'wrong_hotel', visibleIdentityConflict: false, visibleLocationConflict: false,
    identityEvidence: { status: 'conflict', basis: 'photo_local', evidenceIds: ['caption-1'], quote: 'Guest suite at Other Hotel', observedIdentity: 'Other Hotel', explanation: '逐图图注明确属于另一酒店' },
  };
  for (const audit of [
    conflicting,
    { ...conflicting, hardRejectCode: 'wrong_subject' },
    { ...conflicting, identityEvidence: { status: 'insufficient', basis: 'none', evidenceIds: [] } },
  ]) {
    const effective = applyKnowledgeSourcePathEvidence(target, audit, pathDecision);
    assert.deepEqual(effective, audit);
    assert.equal(failedHardRequirement(target, effective), audit.hardRejectCode);
  }
  const { auditEvidenceVersion, identityEvidence, ...legacyAudit } = conflicting;
  const legacy = applyKnowledgeSourcePathEvidence(target, legacyAudit, pathDecision);
  assert.equal(legacy.hardRejectCode, 'none');
  assert.equal(legacy.hotelIdentityMatch, true);
});

for (const failFirstDownloads of [false, true]) test(`后备查询保留下载机会且先完成当前入池处理：${failFirstDownloads ? '下载失败' : '分批硬拒绝'}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-query-reservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let searches = 0;
  let downloadCount = 0;
  let activeReviews = 0;
  const result = await runImageSearchSkill({
    root, slots: [slot], downloadsPerSlot: 6, sourcePagesPerSlot: 4,
    visionApiKey: 'fixture', visionBaseUrl: 'https://vision.invalid', visionModel: 'fixture',
    adapters: {
      searchWebBatch: async ({ queries }) => {
        assert.equal(queries.length, 1);
        assert.equal(activeReviews, 0);
        searches += 1; events.push(`search:${searches}`);
        return [{ pageUrl: `https://example.com/query-${searches}/gallery` }];
      },
      searchCommonsImages: async () => [],
      extractPageImages: async page => Array.from({ length: 8 }, (_, i) => ({ ...page, imageUrl: `${page.pageUrl}/image-${i}.jpg`, alt: 'wildebeest herd river crossing' })),
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        downloadCount += 1;
        if (failFirstDownloads && candidate.pageUrl.includes('query-1')) throw new Error('HTTP 403');
        const fileName = `photo-${downloadCount}.jpg`;
        const filePath = path.join(directory, fileName);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#358859' } }).jpeg().toFile(filePath);
        return { filePath, publicUrl: `${publicPrefix}/${fileName}`, sha256: candidate.imageUrl, width: 1200, height: 800 };
      },
      judgeCandidatesBatch: async ({ candidates }) => {
        activeReviews += 1;
        events.push(`audit:${searches}:${candidates.length}`);
        await Promise.resolve();
        activeReviews -= 1;
        return candidates.map(candidate => judgment(candidate, candidate.pageUrl.includes('query-2')));
      },
    },
  });
  const output = result.results[0];
  const evidence = output.pipelineEvidence.webExecution;
  assert.equal(output.status, 'success');
  assert.equal(searches, 2);
  assert.equal(downloadCount, 6);
  assert.equal(evidence.downloadsUsed, 6);
  assert.deepEqual(evidence.queryReports.map(report => report.admittedCandidates), [5, 1]);
  assert.deepEqual(evidence.queryReports.map(report => report.deferredCandidates), [3, 7]);
  assert.equal(evidence.queryReports[0].allowance.reservedDownloads, 1);
  assert.deepEqual(events, failFirstDownloads ? ['search:1', 'search:2', 'audit:2:1'] : ['search:1', 'audit:1:4', 'audit:1:1', 'search:2', 'audit:2:1']);
  assert.equal(output.candidates.length, 16);
  assert.equal(new Set(output.candidates.map(candidate => candidate.candidateId)).size, 16);
  const deferred = output.candidates.filter(candidate => candidate.webDownloadAdmission === 'deferred');
  assert.equal(deferred.length, 10);
  assert.ok(deferred.every(candidate => candidate.qualificationStatus === 'unreviewed' && candidate.originalDownloadStatus === 'not_requested'));
  assert.equal(deferred.filter(candidate => candidate.webDownloadDeferredReason === 'query_download_allowance').length, 6);
  assert.equal(deferred.filter(candidate => candidate.webDownloadDeferredReason === 'source_diversity_limit').length, 4);
  assert.equal(output.candidates.filter(candidate => candidate.originalDownloadStatus === 'failed').length, failFirstDownloads ? 5 : 0);
  assert.equal(result.metrics.businessBatches, 1);
  assert.equal(result.metrics.automaticFollowupRounds, 0);
});

test('相同内容的已下载候选保留真实状态，借用的抓取会话跨步骤复用且不被关闭', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-query-duplicates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let closed = false;
  const diagnostics = { browserPages: 1, browserFailures: 0 };
  const retrievalSession = { getDiagnostics: () => diagnostics, close: async () => { closed = true; } };
  let audited = 0;
  const result = await runImageSearchSkill({
    root,
    slots: [{ ...slot, queryCore: { subject: 'wildebeest herd', action: 'river crossing' }, fidelityQuery: 'wildebeest herd river crossing', alternateQueries: [] }],
    downloadsPerSlot: 3,
    visionApiKey: 'fixture', visionBaseUrl: 'https://vision.invalid', visionModel: 'fixture',
    adapters: {
      retrievalSession,
      searchWebBatch: async () => [{ pageUrl: 'https://example.com/gallery' }],
      searchCommonsImages: async () => [],
      extractPageImages: async (page, options) => {
        assert.equal(options.retrievalSession, retrievalSession);
        return Array.from({ length: 3 }, (_, i) => ({ ...page, imageUrl: `${page.pageUrl}/photo-${i}.jpg`, alt: 'wildebeest herd river crossing', acquisitionMethod: 'browser' }));
      },
      downloadCandidate: async (candidate, options) => {
        assert.equal(options.retrievalSession, retrievalSession);
        const fileName = candidate.imageUrl.split('/').at(-1);
        const filePath = path.join(options.directory, fileName);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#358859' } }).jpeg().toFile(filePath);
        return { filePath, publicUrl: `${options.publicPrefix}/${fileName}`, sha256: 'same-photo-bytes', width: 1200, height: 800, downloadedImageUrl: candidate.imageUrl, downloadVariantAttempts: 2, acquisitionMethod: candidate.acquisitionMethod };
      },
      judgeCandidatesBatch: async ({ candidates }) => { audited += candidates.length; return candidates.map(candidate => judgment(candidate, true)); },
    },
  });
  assert.equal(result.results[0].status, 'success');
  assert.equal(audited, 1);
  assert.equal(result.results[0].pipelineEvidence.webExecution.queryReports[0].contentDuplicates, 2);
  const candidates = result.results[0].candidates;
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(candidate => candidate.originalDownloadStatus === 'success' && candidate.originalDownloaded));
  assert.ok(candidates.every(candidate => candidate.downloadedImageUrl && candidate.downloadVariantAttempts === 2 && candidate.acquisitionMethod === 'browser'));
  assert.equal(candidates.filter(candidate => candidate.webProcessingReason === 'duplicate_downloaded_content').length, 2);
  assert.deepEqual(result.metrics.imageRetrieval, diagnostics);
  assert.equal(closed, false);
});

test('自有抓取会话关闭产生的保留目录诊断进入返回指标', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-session-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const retainedRuntimePath = path.join(root, 'mock-retained-runtime');
  const diagnostics = { browserPages: 0 };
  let closed = false;
  const result = await runImageSearchSkill({ root, slots: [{ ...slot, userLocked: true }], adapters: {
    createImageRetrievalSession: () => ({
      close: async () => {
        if (closed) return;
        closed = true;
        events.push('close');
        diagnostics.retainedRuntimePath = retainedRuntimePath;
      },
      getDiagnostics: () => { events.push('diagnostics'); return { ...diagnostics }; },
    }),
  } });
  assert.deepEqual(events, ['close', 'diagnostics']);
  assert.equal(result.metrics.imageRetrieval.retainedRuntimePath, retainedRuntimePath);
});

test('Commons直接来源不消耗提取页面预留且仍受累计下载预算，已访问页不重复计数', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-commons-page-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extractedPages = [];
  let searches = 0;
  let downloads = 0;
  const firstPages = Array.from({ length: 3 }, (_, i) => ({ pageUrl: `https://example.com/first-${i}` }));
  const result = await runImageSearchSkill({
    root, slots: [slot], downloadsPerSlot: 6, sourcePagesPerSlot: 4,
    visionApiKey: 'fixture', visionBaseUrl: 'https://vision.invalid', visionModel: 'fixture',
    adapters: {
      searchWebBatch: async () => ++searches === 1 ? firstPages : [firstPages[0], { pageUrl: 'https://example.com/fallback' }],
      searchCommonsImages: async () => Array.from({ length: 6 }, (_, i) => ({ pageUrl: `https://commons.wikimedia.org/wiki/File:photo-${i}.jpg`, imageUrl: `https://upload.wikimedia.org/photo-${i}.jpg`, alt: 'wildebeest herd river crossing' })),
      extractPageImages: async page => {
        extractedPages.push(page.pageUrl);
        return [{ ...page, imageUrl: `${page.pageUrl}/photo.jpg`, alt: 'wildebeest herd river crossing' }];
      },
      downloadCandidate: async (candidate, { directory, publicPrefix }) => {
        const fileName = `photo-${++downloads}.jpg`;
        const filePath = path.join(directory, fileName);
        await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#358859' } }).jpeg().toFile(filePath);
        return { filePath, publicUrl: `${publicPrefix}/${fileName}`, sha256: candidate.imageUrl, width: 1200, height: 800 };
      },
      judgeCandidatesBatch: async ({ candidates }) => candidates.map(candidate => judgment(candidate, candidate.pageUrl.endsWith('/fallback'))),
    },
  });
  const evidence = result.results[0].pipelineEvidence.webExecution;
  assert.equal(result.results[0].status, 'success');
  assert.equal(searches, 2);
  assert.equal(downloads, 6);
  assert.equal(evidence.downloadsUsed, 6);
  assert.deepEqual(evidence.queryReports.map(report => report.admittedCandidates), [5, 1]);
  assert.deepEqual(evidence.queryReports.map(report => report.accessedPages), [3, 1]);
  assert.deepEqual(evidence.queryReports.map(report => report.effectivePages), [3, 1]);
  assert.deepEqual(evidence.queryReports.map(report => report.directSourcePages), [6, 0]);
  assert.equal(evidence.queryReports[0].allowance.reservedPages, 1);
  assert.equal(evidence.pagesUsed, 4);
  assert.equal(evidence.effectivePagesUsed, 4);
  assert.equal(extractedPages.length, new Set(extractedPages).size);
  assert.equal(result.results[0].candidates.length, 10);
});
