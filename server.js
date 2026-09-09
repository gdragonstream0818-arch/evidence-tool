/**
 * 악성 게시글 증거 수집 도구 - MVP v4
 *
 * 흐름:
 * URL 입력
 * → Render 서버에서 PDF 생성
 * → /tmp 에 임시 저장
 * → evidenceId 발급
 * → 모바일에서 PDF 미리보기
 * → 사용자가 정상 여부 확인
 * → 신고 진행
 *
 * PDF는 기본 1시간 후 자동 삭제
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const KOREAN_FONT_LINK =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap';

const EVIDENCE_TTL_MS = 60 * 60 * 1000; // 1시간

const TEMP_DIR = path.join(os.tmpdir(), 'evidence-tool');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// evidenceId -> metadata
const evidenceStore = new Map();

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

  'fmkorea.com': {
    title: '.np_18px, .title',
    author: '.member_plate, .top_content .author',
    date: '.date.m_no',
  },
};

function getProfile(hostname) {
  return SITE_PROFILES[hostname] || null;
}

function createEvidenceId() {
  return crypto.randomUUID();
}

function getEvidence(id) {
  const evidence = evidenceStore.get(id);

  if (!evidence) {
    return null;
  }

  if (Date.now() - evidence.createdTimestamp > EVIDENCE_TTL_MS) {
    deleteEvidence(id);
    return null;
  }

  return evidence;
}

function deleteEvidence(id) {
  const evidence = evidenceStore.get(id);

  if (!evidence) return;

  try {
    if (fs.existsSync(evidence.filePath)) {
      fs.unlinkSync(evidence.filePath);
    }
  } catch (err) {
    console.error('PDF 삭제 실패:', err);
  }

  evidenceStore.delete(id);
}

async function extractMetadata(page, profile) {
  return page.evaluate((profile) => {
    function pickText(selector) {
      if (!selector) return null;

      const el = document.querySelector(selector);

      return el
        ? el.innerText.trim()
        : null;
    }

    function metaContent(name) {
      const el =
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[name="${name}"]`);

      return el
        ? el.getAttribute('content')
        : null;
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

    return {
      title,
      author,
      date,
    };
  }, profile);
}

async function injectKoreanFont(page) {
  await page.addStyleTag({
    url: KOREAN_FONT_LINK,
  });

  await page.addStyleTag({
    content: `
      * {
        font-family:
          'Noto Sans KR',
          'Malgun Gothic',
          'Apple SD Gothic Neo',
          sans-serif !important;
      }
    `,
  });
}

async function waitForFontsWithTimeout(page, ms = 5000) {
  await page.evaluate((timeoutMs) => {
    return Promise.race([
      document.fonts.ready,
      new Promise((resolve) =>
        setTimeout(resolve, timeoutMs)
      ),
    ]);
  }, ms);
}

async function autoScrollToBottom(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;

      const distance = 600;

      const timer = setInterval(() => {
        const scrollHeight =
          document.body.scrollHeight;

        window.scrollBy(0, distance);

        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);

          window.scrollTo(0, 0);

          resolve();
        }
      }, 200);
    });
  });
}


// ------------------------------------------------------------
// URL → PDF 생성 + 서버 임시저장
// ------------------------------------------------------------

app.post('/api/capture', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      error: 'URL이 필요합니다.',
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

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({
      error: 'http 또는 https URL만 사용할 수 있습니다.',
    });
  }

  let browser;

  const capturedAt = new Date();

  try {
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

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    const profile =
      getProfile(parsed.hostname);

    // 원본 HTML 기준 SHA-256
    const originalHtml =
      await page.content();

    const hash =
      crypto
        .createHash('sha256')
        .update(originalHtml)
        .digest('hex');

    const metadata =
      await extractMetadata(
        page,
        profile
      );

    await autoScrollToBottom(page);

    await injectKoreanFont(page);

    await waitForFontsWithTimeout(
      page,
      5000
    );

    const pdfBuffer =
      await page.pdf({
        format: 'A4',

        printBackground: true,

        displayHeaderFooter: true,

        headerTemplate: `
          <div
            style="
              font-size:9px;
              width:100%;
              padding:0 10mm;
              display:flex;
              justify-content:space-between;
              color:#555;
            "
          >
            <span class="title"></span>
            <span class="date"></span>
          </div>
        `,

        footerTemplate: `
          <div
            style="
              font-size:9px;
              width:100%;
              padding:0 10mm;
              display:flex;
              justify-content:space-between;
              color:#555;
            "
          >
            <span class="url"></span>

            <span>
              <span class="pageNumber"></span>
              /
              <span class="totalPages"></span>
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

    await browser.close();

    browser = null;

    const evidenceId =
      createEvidenceId();

    const filePath =
      path.join(
        TEMP_DIR,
        `${evidenceId}.pdf`
      );

    fs.writeFileSync(
      filePath,
      pdfBuffer
    );

    const evidence = {
      id: evidenceId,

      filePath,

      url,

      title:
        metadata.title || null,

      author:
        metadata.author || null,

      date:
        metadata.date || null,

      capturedAt:
        capturedAt.toISOString(),

      hash,

      confirmed: false,

      createdTimestamp:
        Date.now(),
    };

    evidenceStore.set(
      evidenceId,
      evidence
    );

    return res.json({
      success: true,

      evidenceId,

      previewUrl:
        `/api/evidence/${evidenceId}/pdf`,

      downloadUrl:
        `/api/evidence/${evidenceId}/download`,

      metadata: {
        url:
          evidence.url,

        title:
          evidence.title,

        author:
          evidence.author,

        date:
          evidence.date,

        capturedAt:
          evidence.capturedAt,

        hash:
          evidence.hash,
      },
    });

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

    return res.status(500).json({
      error:
        '증거 수집 중 오류가 발생했습니다.',

      detail:
        String(err),
    });
  }
});


// ------------------------------------------------------------
// PDF 미리보기
// ------------------------------------------------------------

app.get(
  '/api/evidence/:id/pdf',
  (req, res) => {

    const evidence =
      getEvidence(req.params.id);

    if (!evidence) {
      return res.status(404).send(
        '증거 파일이 없거나 만료되었습니다.'
      );
    }

    res.setHeader(
      'Content-Type',
      'application/pdf'
    );

    res.setHeader(
      'Content-Disposition',
      'inline'
    );

    res.sendFile(
      evidence.filePath
    );
  }
);


// ------------------------------------------------------------
// PDF 다운로드 (보조 기능)
// ------------------------------------------------------------

app.get(
  '/api/evidence/:id/download',
  (req, res) => {

    const evidence =
      getEvidence(req.params.id);

    if (!evidence) {
      return res.status(404).send(
        '증거 파일이 없거나 만료되었습니다.'
      );
    }

    res.download(
      evidence.filePath,
      `evidence_${req.params.id}.pdf`
    );
  }
);


// ------------------------------------------------------------
// 증거 정보 조회
// ------------------------------------------------------------

app.get(
  '/api/evidence/:id',
  (req, res) => {

    const evidence =
      getEvidence(req.params.id);

    if (!evidence) {
      return res.status(404).json({
        error:
          '증거 파일이 없거나 만료되었습니다.',
      });
    }

    res.json({
      evidenceId:
        evidence.id,

      url:
        evidence.url,

      title:
        evidence.title,

      author:
        evidence.author,

      date:
        evidence.date,

      capturedAt:
        evidence.capturedAt,

      hash:
        evidence.hash,

      confirmed:
        evidence.confirmed,
    });
  }
);


// ------------------------------------------------------------
// 사용자가 PDF 정상 확인
// ------------------------------------------------------------

app.post(
  '/api/evidence/:id/confirm',
  (req, res) => {

    const evidence =
      getEvidence(req.params.id);

    if (!evidence) {
      return res.status(404).json({
        error:
          '증거 파일이 없거나 만료되었습니다.',
      });
    }

    evidence.confirmed = true;

    evidence.confirmedAt =
      new Date().toISOString();

    res.json({
      success: true,

      evidenceId:
        evidence.id,

      confirmed:
        true,

      // 다음 단계에서 이 ID를
      // Galaxy 자동입력 서버에 전달할 예정
      nextStep:
        'report',
    });
  }
);


// ------------------------------------------------------------
// 만료된 PDF 자동 정리
// ------------------------------------------------------------

setInterval(() => {
  for (
    const [id, evidence]
    of evidenceStore.entries()
  ) {
    if (
      Date.now() -
      evidence.createdTimestamp >
      EVIDENCE_TTL_MS
    ) {
      deleteEvidence(id);
    }
  }
}, 10 * 60 * 1000);


// ------------------------------------------------------------
// Render
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
