/**
 * 악플/명예훼손 신고용 증거 수집 자동화 - MVP 서버 (v2.1)
 * 대상: 디시인사이드 (gall.dcinside.com) 우선 완성
 *
 * v2 변경점:
 *  1) 원본 페이지를 그대로 인쇄하지 않고, 제목/작성자/날짜/본문/댓글만 추출해
 *     깨끗한 전용 페이지에 다시 렌더링한 뒤 그 페이지만 PDF로 출력 (게시판 목록/광고 제거)
 *  2) 웹폰트(Noto Sans KR)를 직접 주입해 Render 서버에 한글 시스템 폰트가 없어도
 *     PDF에 한글이 정상 출력되도록 함
 *
 * v2.1 변경점 (버그 수정):
 *  - page.setContent()의 waitUntil을 'networkidle0' -> 'domcontentloaded'로 변경
 *    (본문 이미지가 리퍼러 차단 등으로 계속 재시도되면 networkidle0이 영원히 끝나지 않아
 *     타임아웃 에러가 나던 문제 해결)
 *  - 폰트 로딩 대기를 최대 5초로 제한 (document.fonts.ready가 안 끝나도 강제로 진행)
 *
 * 주의:
 *  - SITE_PROFILES의 선택자(특히 comments)는 예시이며, 실제 배포 전 반드시
 *    브라우저 개발자 도구로 dcinside 실제 게시글 페이지에서 검증/수정이 필요합니다.
 *  - 프로필이 없는 사이트는 기존 방식(전체 페이지 인쇄 + 클러터 숨김)으로 폴백합니다.
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// 한글 렌더링용 웹폰트 (Render 서버에 한글 시스템 폰트가 없어도 이걸로 렌더링됨)
const KOREAN_FONT_LINK =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap';

// ---------------------------------------------------------------------------
// 사이트별 추출 프로필 (예시 - 실제 배포 전 반드시 실사이트에서 검증 필요)
// ---------------------------------------------------------------------------
const SITE_PROFILES = {
  'gall.dcinside.com': {
    title: '.title_subject',
    author: '.gall_writer .nickname',
    date: '.gall_date',
    content: '.write_div',
    // ⚠️ 검증 필요: 실제 댓글 리스트 컨테이너 클래스명을 개발자 도구로 확인 후 수정하세요.
    comments: '.cmt_listwrap',
  },
  'www.fmkorea.com': {
    title: '.np_18px, .title',
    author: '.member_plate, .top_content .author',
    date: '.date.m_no',
    content: '.xe_content',
    comments: null, // 추후 확인 후 추가
  },
};

function getProfile(hostname) {
  return SITE_PROFILES[hostname] || null;
}

// ---------------------------------------------------------------------------
// 메타데이터 + 원본 HTML 블록(본문/댓글) 추출
// ---------------------------------------------------------------------------
async function extractContent(page, profile) {
  return page.evaluate((profile) => {
    function pickText(selector) {
      if (!selector) return null;
      const el = document.querySelector(selector);
      return el ? el.innerText.trim() : null;
    }

    function pickHtml(selector) {
      if (!selector) return null;
      const el = document.querySelector(selector);
      if (!el) return null;
      // 스크립트 태그는 제거하고 가져온다 (안전을 위해)
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script').forEach((s) => s.remove());
      return clone.innerHTML;
    }

    function metaContent(name) {
      const el =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`);
      return el ? el.getAttribute('content') : null;
    }

    const title =
      (profile && pickText(profile.title)) || metaContent('og:title') || document.title || null;

    const author =
      (profile && pickText(profile.author)) ||
      metaContent('article:author') ||
      metaContent('author') ||
      null;

    const date =
      (profile && pickText(profile.date)) || metaContent('article:published_time') || null;

    const contentHtml = (profile && pickHtml(profile.content)) || null;
    const commentsHtml = (profile && pickHtml(profile.comments)) || null;

    // 폴백용 (프로필 매칭 실패 시 화면 텍스트 요약)
    const fallbackText = metaContent('og:description') || null;

    return { title, author, date, contentHtml, commentsHtml, fallbackText };
  }, profile);
}

// ---------------------------------------------------------------------------
// 클러터 제거용 인쇄 CSS 주입 (프로필 없는 사이트 폴백에서만 사용)
// ---------------------------------------------------------------------------
async function injectPrintStyles(page) {
  await page.addStyleTag({
    content: `
      @media print {
        header, nav, footer, .header, .gnb, .lnb,
        .ad, .ad-banner, .adsbygoogle, .banner,
        .comment-input-box, .btn_area, .sns_area {
          display: none !important;
        }
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// 폰트 로딩 대기 (최대 5초 - 안 끝나도 강제로 진행해서 타임아웃 방지)
// ---------------------------------------------------------------------------
async function waitForFontsWithTimeout(page, ms = 5000) {
  await page.evaluate((timeoutMs) => {
    return Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }, ms);
}

// ---------------------------------------------------------------------------
// 추출된 내용을 깨끗한 증거용 문서로 재구성 (한글 폰트 포함)
// ---------------------------------------------------------------------------
function buildEvidenceHtml({ url, title, author, date, contentHtml, commentsHtml, fallbackText }) {
  const esc = (s) => (s || '').toString().replace(/</g, '&lt;');

  return `
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<link rel="stylesheet" href="${KOREAN_FONT_LINK}">
<style>
  * { font-family: 'Noto Sans KR', sans-serif !important; }
  body { margin: 0; padding: 24px; color: #111; line-height: 1.6; font-size: 14px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 20px; border-bottom: 1px solid #ddd; padding-bottom: 12px; }
  .meta div { margin-bottom: 2px; }
  .section-title { font-size: 14px; font-weight: 700; margin: 24px 0 8px; border-left: 4px solid #2563eb; padding-left: 8px; }
  .content-box, .comments-box { border: 1px solid #eee; border-radius: 6px; padding: 16px; }
  img { max-width: 100%; }
</style>
</head>
<body>
  <h1>${esc(title) || '(제목 추출 실패)'}</h1>
  <div class="meta">
    <div>작성자: ${esc(author) || '(추출 실패)'}</div>
    <div>작성일: ${esc(date) || '(추출 실패)'}</div>
    <div>원본 URL: ${esc(url)}</div>
  </div>

  <div class="section-title">본문</div>
  <div class="content-box">${contentHtml || esc(fallbackText) || '(본문 추출 실패 - 원본 URL 확인 필요)'}</div>

  ${
    commentsHtml
      ? `<div class="section-title">댓글</div><div class="comments-box">${commentsHtml}</div>`
      : ''
  }
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// POST /api/capture  { url: string }
// ---------------------------------------------------------------------------
app.post('/api/capture', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url이 필요합니다.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: '유효하지 않은 URL입니다.' });
  }

  const capturedAt = new Date();
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const profile = getProfile(parsed.hostname);

    // 무결성 검증용 원본 HTML 해시 (재구성 전, 원본 그대로 기준)
    const originalHtml = await page.content();
    const hash = crypto.createHash('sha256').update(originalHtml).digest('hex');

    const extracted = await extractContent(page, profile);

    let pdfBuffer;

    if (profile && extracted.contentHtml) {
      // --- 프로필 매칭 성공: 깨끗한 증거 문서로 재구성해서 인쇄 ---
      const evidenceHtml = buildEvidenceHtml({ url, ...extracted });

      // networkidle0 대신 domcontentloaded 사용:
      // 본문 이미지가 리퍼러 차단 등으로 계속 재시도되면 networkidle0이 끝나지 않아
      // 타임아웃 에러가 나던 문제를 해결
      await page.setContent(evidenceHtml, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // 폰트 로딩은 최대 5초만 기다리고 안 되면 그냥 진행
      await waitForFontsWithTimeout(page, 5000);

      pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size:9px; width:100%; padding:0 10mm; color:#555;">출처 URL: ${url}</div>`,
        footerTemplate: `<div style="font-size:9px; width:100%; padding:0 10mm; color:#555; display:flex; justify-content:space-between;"><span>수집 일시(KST): ${capturedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><span>SHA-256: ${hash.slice(0, 16)}...</span></div>`,
        margin: { top: '20mm', bottom: '20mm', left: '10mm', right: '10mm' },
      });
    } else {
      // --- 프로필 없음/매칭 실패: 기존 방식(전체 페이지 인쇄)으로 폴백 ---
      await page.addStyleTag({ url: KOREAN_FONT_LINK });
      await page.addStyleTag({ content: `* { font-family: 'Noto Sans KR', sans-serif !important; }` });
      await waitForFontsWithTimeout(page, 5000);
      await injectPrintStyles(page);

      pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size:9px; width:100%; padding:0 10mm; color:#555;">출처 URL: ${url}</div>`,
        footerTemplate: `<div style="font-size:9px; width:100%; padding:0 10mm; color:#555; display:flex; justify-content:space-between;"><span>수집 일시(KST): ${capturedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</span><span>SHA-256: ${hash.slice(0, 16)}...</span></div>`,
        margin: { top: '20mm', bottom: '20mm', left: '10mm', right: '10mm' },
      });
    }

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="evidence_${Date.now()}.pdf"`);
    res.setHeader(
      'X-Evidence-Meta',
      encodeURIComponent(
        JSON.stringify({
          url,
          capturedAt: capturedAt.toISOString(),
          hash,
          title: extracted.title,
          author: extracted.author,
          date: extracted.date,
        })
      )
    );

    res.send(pdfBuffer);
  } catch (err) {
    if (browser) await browser.close();
    console.error(err);
    res.status(500).json({ error: '증거 수집 중 오류가 발생했습니다.', detail: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Evidence tool server running on http://localhost:${PORT}`);
});
