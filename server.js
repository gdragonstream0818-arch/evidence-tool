/**
 * 악플/명예훼손 신고용 증거 수집 자동화 - MVP 서버
 * 대상: 일반 커뮤니티 (공개 게시글/댓글)
 *
 * 흐름:
 *  1) 클라이언트(모바일 웹앱)가 URL을 POST로 전송
 *  2) 서버가 Puppeteer(헤드리스 브라우저)로 해당 URL 접속
 *  3) 제목/작성자/날짜 등 메타데이터 추출 (사이트별 프로필 + 범용 fallback)
 *  4) 불필요한 광고/네비게이션 요소를 인쇄용 CSS로 숨김
 *  5) 브라우저 인쇄(page.pdf) 방식으로 PDF 생성 - 헤더/푸터에 URL, 수집 시각 자동 삽입
 *  6) 페이지 HTML의 SHA-256 해시를 계산해 무결성 검증용 메타데이터로 함께 반환
 *  7) 완성된 PDF를 클라이언트로 바로 스트리밍 (서버에 영구 저장하지 않음)
 *
 * 주의:
 *  - 이 서버는 "공개된" 게시글/댓글만 수집할 수 있습니다. 로그인 후에만 보이는 콘텐츠는
 *    이 구조로는 접근할 수 없습니다 (README 참고).
 *  - 사이트별 CSS 선택자(SITE_PROFILES)는 예시이며, 실제 사이트 구조에 맞춰 반드시 검증/수정이 필요합니다.
 *  - 신고 사이트 자동 제출 기능은 이번 MVP에는 포함하지 않았습니다.
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

// ---------------------------------------------------------------------------
// 사이트별 추출 프로필 (예시 - 실제 배포 전 반드시 실사이트에서 검증 필요)
// ---------------------------------------------------------------------------
const SITE_PROFILES = {
  'gall.dcinside.com': {
    title: '.title_subject',
    author: '.gall_writer .nickname',
    date: '.gall_date',
    content: '.write_div',
  },
  'www.fmkorea.com': {
    title: '.np_18px, .title',
    author: '.member_plate, .top_content .author',
    date: '.date.m_no',
    content: '.xe_content',
  },
  // 필요한 커뮤니티를 여기에 계속 추가
};

function getProfile(hostname) {
  return SITE_PROFILES[hostname] || null;
}

// ---------------------------------------------------------------------------
// 메타데이터 추출 (사이트 프로필 우선, 없으면 범용 og:meta / DOM 기반 fallback)
// ---------------------------------------------------------------------------
async function extractMetadata(page, profile) {
  return page.evaluate((profile) => {
    function pick(selector) {
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
      (profile && pick(profile.title)) ||
      metaContent('og:title') ||
      document.title ||
      null;

    const author =
      (profile && pick(profile.author)) ||
      metaContent('article:author') ||
      metaContent('author') ||
      null;

    const date =
      (profile && pick(profile.date)) ||
      metaContent('article:published_time') ||
      null;

    const content =
      (profile && pick(profile.content)) ||
      metaContent('og:description') ||
      null;

    return { title, author, date, content };
  }, profile);
}

// ---------------------------------------------------------------------------
// 인쇄 시 불필요한 요소(광고/네비게이션 등) 숨기는 CSS 주입
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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const profile = getProfile(parsed.hostname);
    const metadata = await extractMetadata(page, profile);

    // 무결성 검증용 원본 HTML 해시
    const html = await page.content();
    const hash = crypto.createHash('sha256').update(html).digest('hex');

    await injectPrintStyles(page);

    const dateStr = capturedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-size:9px; width:100%; padding:0 10mm; color:#555;">
          출처 URL: ${url}
        </div>`,
      footerTemplate: `
        <div style="font-size:9px; width:100%; padding:0 10mm; color:#555; display:flex; justify-content:space-between;">
          <span>수집 일시(KST): ${dateStr}</span>
          <span>SHA-256: ${hash.slice(0, 16)}...</span>
        </div>`,
      margin: { top: '20mm', bottom: '20mm', left: '10mm', right: '10mm' },
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="evidence_${Date.now()}.pdf"`
    );
    res.setHeader('X-Evidence-Meta', encodeURIComponent(JSON.stringify({
      url,
      capturedAt: capturedAt.toISOString(),
      hash,
      ...metadata,
    })));

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
