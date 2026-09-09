/**
 * 악플/명예훼손 신고용 증거 수집 자동화 - MVP 서버 (v2)
 * 대상: 디시인사이드 (gall.dcinside.com) 우선 완성
 *
 * 기능:
 *  1) URL 접속
 *  2) 제목/작성자/날짜/본문/댓글 추출
 *  3) 원본 HTML SHA-256 해시 생성
 *  4) 깔끔한 증거용 HTML로 재구성
 *  5) Noto Sans KR 웹폰트 적용
 *  6) PDF 생성 후 바로 다운로드
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

// ------------------------------------------------------------
// 한글 폰트
// ------------------------------------------------------------

const KOREAN_FONT_LINK =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap';

// ------------------------------------------------------------
// 사이트별 프로필
// ------------------------------------------------------------

const SITE_PROFILES = {
  'gall.dcinside.com': {
    title: '.title_subject',
    author: '.gall_writer .nickname',
    date: '.gall_date',
    content: '.write_div',

    // 실제 디시 구조에 따라 추후 수정 가능
    comments: '.cmt_listwrap',
  },

  'www.fmkorea.com': {
    title: '.np_18px, .title',
    author: '.member_plate, .top_content .author',
    date: '.date.m_no',
    content: '.xe_content',
    comments: null,
  },
};

function getProfile(hostname) {
  return SITE_PROFILES[hostname] || null;
}

// ------------------------------------------------------------
// 데이터 추출
// ------------------------------------------------------------

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
      (profile && pickText(profile.title)) ||
      metaContent('og:title') ||
      document.title ||
      null;

    const author =
      (profile && pickText(profile.author)) ||
      metaContent('article:author') ||
      metaContent('author') ||
      null;

    const date =
      (profile && pickText(profile.date)) ||
      metaContent('article:published_time') ||
      null;

    const contentHtml =
      (profile && pickHtml(profile.content)) || null;

    const commentsHtml =
      (profile && pickHtml(profile.comments)) || null;

    const fallbackText =
      metaContent('og:description') || null;

    return {
      title,
      author,
      date,
      contentHtml,
      commentsHtml,
      fallbackText,
    };
  }, profile);
}

// ------------------------------------------------------------
// 일반 사이트용 불필요 요소 제거
// ------------------------------------------------------------

async function injectPrintStyles(page) {
  await page.addStyleTag({
    content: `
      @media print {

        header,
        nav,
        footer,
        .header,
        .gnb,
        .lnb,
        .ad,
        .ad-banner,
        .adsbygoogle,
        .banner,
        .comment-input-box,
        .btn_area,
        .sns_area {

          display: none !important;

        }

      }
    `,
  });
}

// ------------------------------------------------------------
// HTML 이스케이프
// ------------------------------------------------------------

function escapeHtml(value) {
  if (!value) return '';

  return value
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ------------------------------------------------------------
// 증거용 HTML 생성
// ------------------------------------------------------------

function buildEvidenceHtml({
  url,
  title,
  author,
  date,
  contentHtml,
  commentsHtml,
  fallbackText,
}) {

  return `

<!DOCTYPE html>

<html lang="ko">

<head>

<meta charset="UTF-8" />

<link
  rel="stylesheet"
  href="${KOREAN_FONT_LINK}"
>

<style>

* {
  font-family: 'Noto Sans KR', sans-serif !important;
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 24px;
  color: #111;
  line-height: 1.6;
  font-size: 14px;
}

h1 {
  font-size: 20px;
  margin: 0 0 10px;
  word-break: break-all;
}

.meta {
  color: #555;
  font-size: 12px;
  margin-bottom: 20px;
  border-bottom: 1px solid #ddd;
  padding-bottom: 12px;
}

.meta div {
  margin-bottom: 4px;
  word-break: break-all;
}

.section-title {
  font-size: 14px;
  font-weight: 700;
  margin: 24px 0 8px;
  border-left: 4px solid #2563eb;
  padding-left: 8px;
}

.content-box,
.comments-box {
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 16px;
  overflow-wrap: anywhere;
}

img {
  max-width: 100%;
  height: auto;
}

video {
  max-width: 100%;
}

</style>

</head>

<body>

<h1>
  ${escapeHtml(title) || '(제목 추출 실패)'}
</h1>

<div class="meta">

  <div>
    작성자:
    ${escapeHtml(author) || '(추출 실패)'}
  </div>

  <div>
    작성일:
    ${escapeHtml(date) || '(추출 실패)'}
  </div>

  <div>
    원본 URL:
    ${escapeHtml(url)}
  </div>

</div>

<div class="section-title">
본문
</div>

<div class="content-box">

${
  contentHtml ||
  escapeHtml(fallbackText) ||
  '(본문 추출 실패 - 원본 URL 확인 필요)'
}

</div>

${
  commentsHtml
    ? `

<div class="section-title">
댓글
</div>

<div class="comments-box">
${commentsHtml}
</div>

`
    : ''
}

</body>

</html>

`;
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------

app.post('/api/capture', async (req, res) => {

  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {

    return res.status(400).json({
      error: 'url이 필요합니다.',
    });

  }

  let parsed;

  try {

    parsed = new URL(url);

  } catch {

    return res.status(400).json({
      error: '유효하지 않은 URL입니다.',
    });

  }

  const capturedAt = new Date();

  let browser;

  try {

    // --------------------------------------------------------
    // Chromium 실행
    // --------------------------------------------------------

    browser = await puppeteer.launch({

      headless: 'new',

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],

    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1280,
      height: 900,
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0 Safari/537.36'
    );

    // --------------------------------------------------------
    // 페이지 접속
    // --------------------------------------------------------

    await page.goto(url, {

      waitUntil: 'networkidle2',

      timeout: 60000,

    });

    const profile =
      getProfile(parsed.hostname);

    // --------------------------------------------------------
    // 원본 HTML 해시
    // --------------------------------------------------------

    const originalHtml =
      await page.content();

    const hash =
      crypto
        .createHash('sha256')
        .update(originalHtml)
        .digest('hex');

    // --------------------------------------------------------
    // 콘텐츠 추출
    // --------------------------------------------------------

    const extracted =
      await extractContent(
        page,
        profile
      );

    let pdfBuffer;

    // --------------------------------------------------------
    // 사이트 프로필이 있고 본문 추출 성공
    // --------------------------------------------------------

    if (
      profile &&
      extracted.contentHtml
    ) {

      const evidenceHtml =
        buildEvidenceHtml({
          url,
          ...extracted,
        });

      await page.setContent(
        evidenceHtml,
        {
          waitUntil: 'networkidle0',
          timeout: 60000,
        }
      );

      // 폰트 로딩 완료 대기
      await page.evaluate(
        () => document.fonts.ready
      );

      pdfBuffer =
        await page.pdf({

          format: 'A4',

          printBackground: true,

          displayHeaderFooter: true,

          headerTemplate: `

<div style="
  font-size:9px;
  width:100%;
  padding:0 10mm;
  color:#555;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
">

출처 URL:
${escapeHtml(url)}

</div>

`,

          footerTemplate: `

<div style="
  font-size:9px;
  width:100%;
  padding:0 10mm;
  color:#555;
  display:flex;
  justify-content:space-between;
">

<span>

수집 일시(KST):
${capturedAt.toLocaleString(
  'ko-KR',
  {
    timeZone: 'Asia/Seoul',
  }
)}

</span>

<span>

SHA-256:
${hash.slice(0, 16)}...

</span>

</div>

`,

          margin: {
            top: '20mm',
            bottom: '20mm',
            left: '10mm',
            right: '10mm',
          },

        });

    }

    // --------------------------------------------------------
    // 프로필 없음 → 전체 페이지 PDF
    // --------------------------------------------------------

    else {

      await page.addStyleTag({
        url: KOREAN_FONT_LINK,
      });

      await page.addStyleTag({

        content: `

* {
  font-family:
    'Noto Sans KR',
    sans-serif !important;
}

`,

      });

      await page.evaluate(
        () => document.fonts.ready
      );

      await injectPrintStyles(page);

      pdfBuffer =
        await page.pdf({

          format: 'A4',

          printBackground: true,

          displayHeaderFooter: true,

          headerTemplate: `

<div style="
  font-size:9px;
  width:100%;
  padding:0 10mm;
  color:#555;
">

출처 URL:
${escapeHtml(url)}

</div>

`,

          footerTemplate: `

<div style="
  font-size:9px;
  width:100%;
  padding:0 10mm;
  color:#555;
  display:flex;
  justify-content:space-between;
">

<span>

수집 일시(KST):
${capturedAt.toLocaleString(
  'ko-KR',
  {
    timeZone: 'Asia/Seoul',
  }
)}

</span>

<span>

SHA-256:
${hash.slice(0, 16)}...

</span>

</div>

`,

          margin: {
            top: '20mm',
            bottom: '20mm',
            left: '10mm',
            right: '10mm',
          },

        });

    }

    await browser.close();

    browser = null;

    // --------------------------------------------------------
    // PDF 응답
    // --------------------------------------------------------

    res.setHeader(
      'Content-Type',
      'application/pdf'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="evidence_${Date.now()}.pdf"`
    );

    res.setHeader(
      'X-Evidence-Meta',
      encodeURIComponent(
        JSON.stringify({
          url,
          capturedAt:
            capturedAt.toISOString(),
          hash,
          title:
            extracted.title,
          author:
            extracted.author,
          date:
            extracted.date,
        })
      )
    );

    res.send(pdfBuffer);

  } catch (err) {

    console.error(
      'Capture error:',
      err
    );

    if (browser) {

      try {

        await browser.close();

      } catch {}

    }

    res.status(500).json({

      error:
        '증거 수집 중 오류가 발생했습니다.',

      detail:
        String(err),

    });

  }

});

// ------------------------------------------------------------
// 서버 실행
// Render에서는 0.0.0.0 바인딩 필요
// ------------------------------------------------------------

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Evidence tool server running on port ${PORT}`
    );

  }
);
