/**
 * 악플/명예훼손 신고용 증거 수집 자동화 - MVP 서버 (v3)
 * 대상: 디시인사이드 (gall.dcinside.com) 우선 완성
 *
 * v3 변경점 (v2 재구성 방식 폐기):
 *  - 콘텐츠를 추출해서 새 HTML로 재구성하는 방식(buildEvidenceHtml)을 제거
 *  - 원본 페이지를 그대로 열고, 그 페이지 자체에 page.pdf()를 실행 (Ctrl+P와 동일한 결과 지향)
 *  - 원본 DOM/CSS/레이아웃은 전혀 건드리지 않고, 한글 렌더링을 위한 웹폰트만 주입
 *  - 헤더/푸터는 Puppeteer 내장 플레이스홀더(title/date/url/pageNumber/totalPages) 사용
 *    -> Chrome에서 직접 "PDF로 저장"했을 때 나오는 헤더/푸터와 동일한 정보 구성
 *  - 지연로딩 콘텐츠(스크롤해야 나오는 이미지/댓글)를 위해 인쇄 전 자동 스크롤 수행
 *
 * 주의:
 *  - 사이트의 자체 @media print 스타일이 있다면 실제 Chrome 인쇄와 동일하게 그대로 적용됩니다
 *    (이 서버는 별도로 요소를 숨기지 않습니다).
 *  - 폰트 강제 적용(* { font-family: ... !important })은 텍스트 렌더링용이며,
 *    드물게 아이콘 폰트를 쓰는 사이트라면 아이콘이 깨질 수 있습니다.
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
// 한글 폰트 (Render 서버에 한글 시스템 폰트가 없어도 이걸로 렌더링됨)
// ------------------------------------------------------------
const KOREAN_FONT_LINK =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap';

// ------------------------------------------------------------
// 사이트별 메타데이터 선택자 (화면 표시용 - PDF 구조에는 영향 없음)
// ------------------------------------------------------------
const SITE_PROFILES = {
  'gall.dcinside.com': {
    title: '.title_subject',
    author: '.gall_writer .nickname',
    date: '.gall_date',
  },
  'www.fmkorea.com': {
    title: '.np_18px, .title',
    author: '.member_plate, .top_content .author',
    date: '.date.m_no',
  },
};

function getProfile(hostname) {
  return SITE_PROFILES[hostname] || null;
}

// ------------------------------------------------------------
// 메타데이터 추출 (제목/작성자/작성일만 - 화면 확인용, PDF와 무관)
// ------------------------------------------------------------
async function extractMetadata(page, profile) {
  return page.evaluate((profile) => {
    function pickText(selector) {
      if (!selector) return null;
      const el = document.querySelector(selector);
      return el ? el.innerText.trim() : null;
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

    return { title, author, date };
  }, profile);
}

// ------------------------------------------------------------
// 한글 폰트만 주입 (레이아웃/구조는 그대로, 폰트만 교체)
// ------------------------------------------------------------
async function injectKoreanFont(page) {
  await page.addStyleTag({ url: KOREAN_FONT_LINK });
  await page.addStyleTag({
    content: `
      * {
        font-family: 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif !important;
      }
    `,
  });
}

// ------------------------------------------------------------
// 폰트 로딩 대기 (최대 5초 - 안 끝나도 강제로 진행해서 타임아웃 방지)
// ------------------------------------------------------------
async function waitForFontsWithTimeout(page, ms = 5000) {
  await page.evaluate((timeoutMs) => {
    return Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }, ms);
}

// ------------------------------------------------------------
// 지연로딩 콘텐츠(이미지/댓글)까지 로드되도록 끝까지 스크롤
// ------------------------------------------------------------
async function autoScrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 600;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0); // 스크린샷/인쇄 전 원위치로 복귀
          resolve();
        }
      }, 200);
    });
  });
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------
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
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const profile = getProfile(parsed.hostname);

    // 무결성 검증용 원본 HTML 해시 (폰트/스크롤 등 어떤 조작도 하기 전, 원본 그대로 기준)
    const originalHtml = await page.content();
    const hash = crypto.createHash('sha256').update(originalHtml).digest('hex');

    // 화면 표시용 메타데이터 (PDF 구조와는 무관, 앱 UI에만 사용)
    const metadata = await extractMetadata(page, profile);

    // 지연로딩 콘텐츠까지 불러오기 (댓글/이미지 등)
    await autoScrollToBottom(page);

    // 한글 폰트만 주입 (원본 DOM/CSS/레이아웃은 그대로)
    await injectKoreanFont(page);
    await waitForFontsWithTimeout(page, 5000);

    // 원본 페이지를 그대로 인쇄 (Chrome "Ctrl+P → PDF로 저장"과 동일한 방식)
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-size:9px; width:100%; padding:0 10mm; display:flex; justify-content:space-between; color:#555;">
          <span class="title"></span>
          <span class="date"></span>
        </div>`,
      footerTemplate: `
        <div style="font-size:9px; width:100%; padding:0 10mm; display:flex; justify-content:space-between; color:#555;">
          <span class="url"></span>
          <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
        </div>`,
      margin: { top: '20mm', bottom: '20mm', left: '10mm', right: '10mm' },
    });

    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="evidence_${Date.now()}.pdf"`);
    res.setHeader(
      'X-Evidence-Meta',
      encodeURIComponent(
        JSON.stringify({
          url,
          capturedAt: capturedAt.toISOString(),
          hash,
          title: metadata.title,
          author: metadata.author,
          date: metadata.date,
        })
      )
    );

    res.send(pdfBuffer);
  } catch (err) {
    console.error('Capture error:', err);
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    res.status(500).json({
      error: '증거 수집 중 오류가 발생했습니다.',
      detail: String(err),
    });
  }
});

// Render에서는 0.0.0.0 바인딩 필요
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Evidence tool server running on port ${PORT}`);
});
