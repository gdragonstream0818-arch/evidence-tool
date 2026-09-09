const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TEMP_DIR = path.join(os.tmpdir(), 'evidence-tool');
const EVIDENCE_TTL_MS = 60 * 60 * 1000;

fs.mkdirSync(TEMP_DIR, {
  recursive: true,
});

const evidenceStore = new Map();
const reportSessions = new Map();

const GALAXY_URL =
  'https://protect.galaxyuniverse.ai/rights-violations/new';

const KOREAN_FONT_LINK =
  'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap';


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


// ----------------------------------------------------
// 공통 함수
// ----------------------------------------------------

function createEvidenceId() {
  return crypto.randomUUID();
}


function cleanText(value) {
  if (!value) return '';

  return value
    .replace(/\s+/g, ' ')
    .trim();
}


function truncate(value, max) {
  if (!value) return '';

  return value.length > max
    ? value.slice(0, max)
    : value;
}


function normalizePostDate(value) {
  if (!value) {
    return '';
  }

  const match = value.match(
    /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/
  );

  if (!match) {
    return '';
  }

  const year = match[1];
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');

  return `${year}-${month}-${day}`;
}


function detectChannel(url) {
  try {
    const host =
      new URL(url).hostname.toLowerCase();

    if (host.includes('dcinside')) {
      return 'dcinside';
    }

    if (host.includes('fmkorea')) {
      return 'fmkorea';
    }

    if (host.includes('theqoo')) {
      return 'Theqoo';
    }

    if (host.includes('instiz')) {
      return 'instiz';
    }

    if (host.includes('naver')) {
      return 'Naver';
    }

    if (host.includes('nate')) {
      return 'Nate';
    }

    if (host.includes('daum')) {
      return 'Daum Cafe';
    }

    if (host.includes('instagram')) {
      return 'Instagram';
    }

    if (host.includes('facebook')) {
      return 'Facebook';
    }

    if (
      host.includes('twitter') ||
      host === 'x.com' ||
      host.endsWith('.x.com')
    ) {
      return 'X';
    }

    if (host.includes('youtube')) {
      return 'YouTube';
    }

    if (host.includes('tiktok')) {
      return 'TikTok';
    }

    if (host.includes('threads')) {
      return 'Threads';
    }

    return '기타';

  } catch {
    return '기타';
  }
}


async function launchBrowser() {
  return puppeteer.launch({
    headless: true,

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
  });
}


async function autoScrollToBottom(page) {
  await page.evaluate(async () => {

    await new Promise((resolve) => {

      let totalHeight = 0;
      let count = 0;

      const distance = 800;

      const timer = setInterval(() => {

        window.scrollBy(0, distance);

        totalHeight += distance;
        count += 1;

        const scrollHeight =
          document.body.scrollHeight;

        if (
          totalHeight >= scrollHeight ||
          count >= 30
        ) {

          clearInterval(timer);

          window.scrollTo(0, 0);

          resolve();
        }

      }, 150);

    });

  });
}


async function getText(page, selector) {
  if (!selector) {
    return '';
  }

  try {
    return await page.$eval(
      selector,
      el => el.textContent.trim()
    );
  } catch {
    return '';
  }
}


// ----------------------------------------------------
// Galaxy 폼 자동작성용
// ----------------------------------------------------

async function setInputByPlaceholder(
  page,
  placeholderWords,
  value
) {

  if (!value) {
    return false;
  }

  return page.evaluate(
    ({ placeholderWords, value }) => {

      const inputs =
        Array.from(
          document.querySelectorAll(
            'input, textarea'
          )
        );

      const el = inputs.find(input => {

        const placeholder =
          (
            input.getAttribute(
              'placeholder'
            ) || ''
          ).toLowerCase();

        return placeholderWords.some(word =>
          placeholder.includes(
            word.toLowerCase()
          )
        );

      });

      if (!el) {
        return false;
      }

      const prototype =
        el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const descriptor =
        Object.getOwnPropertyDescriptor(
          prototype,
          'value'
        );

      if (
        descriptor &&
        descriptor.set
      ) {

        descriptor.set.call(
          el,
          value
        );

      } else {

        el.value = value;
      }

      el.dispatchEvent(
        new Event(
          'input',
          {
            bubbles: true
          }
        )
      );

      el.dispatchEvent(
        new Event(
          'change',
          {
            bubbles: true
          }
        )
      );

      return true;

    },
    {
      placeholderWords,
      value,
    }
  );
}


async function setFirstTextarea(
  page,
  value
) {

  return page.evaluate(value => {

    const el =
      document.querySelector(
        'textarea'
      );

    if (!el) {
      return false;
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      );

    if (
      descriptor &&
      descriptor.set
    ) {

      descriptor.set.call(
        el,
        value
      );

    } else {

      el.value = value;
    }

    el.dispatchEvent(
      new Event(
        'input',
        {
          bubbles: true
        }
      )
    );

    el.dispatchEvent(
      new Event(
        'change',
        {
          bubbles: true
        }
      )
    );

    return true;

  }, value);
}


async function setDateInput(
  page,
  value
) {

  if (!value) {
    return false;
  }

  return page.evaluate(value => {

    const inputs =
      Array.from(
        document.querySelectorAll(
          'input'
        )
      );

    const el =
      inputs.find(input =>
        input.type === 'date'
      ) ||
      inputs.find(input => {

        const p =
          (
            input.placeholder || ''
          ).toLowerCase();

        return (
          p.includes('날짜') ||
          p.includes('date')
        );

      });

    if (!el) {
      return false;
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      );

    if (
      descriptor &&
      descriptor.set
    ) {

      descriptor.set.call(
        el,
        value
      );

    } else {

      el.value = value;
    }

    el.dispatchEvent(
      new Event(
        'input',
        {
          bubbles: true
        }
      )
    );

    el.dispatchEvent(
      new Event(
        'change',
        {
          bubbles: true
        }
      )
    );

    return true;

  }, value);
}


async function selectOptionByText(
  page,
  patterns
) {

  return page.evaluate(
    patterns => {

      const selects =
        Array.from(
          document.querySelectorAll(
            'select'
          )
        );

      for (
        const select of selects
      ) {

        const options =
          Array.from(
            select.options
          );

        const option =
          options.find(opt => {

            const text =
              (
                opt.textContent || ''
              )
                .trim()
                .toLowerCase();

            return patterns.some(pattern =>
              text.includes(
                pattern.toLowerCase()
              )
            );

          });

        if (!option) {
          continue;
        }

        select.value =
          option.value;

        select.dispatchEvent(
          new Event(
            'input',
            {
              bubbles: true
            }
          )
        );

        select.dispatchEvent(
          new Event(
            'change',
            {
              bubbles: true
            }
          )
        );

        return {
          success: true,
          text:
            option.textContent.trim()
        };
      }

      return {
        success: false
      };

    },
    patterns
  );
}


// custom combobox 대응
async function clickCustomOption(
  page,
  patterns
) {

  for (
    let i = 0;
    i < patterns.length;
    i++
  ) {

    const pattern =
      patterns[i];

    try {

      const result =
        await page.evaluate(
          pattern => {

            const els =
              Array.from(
                document.querySelectorAll(
                  'button, [role="option"], [role="combobox"], div, li'
                )
              );

            const el =
              els.find(node => {

                const text =
                  (
                    node.textContent || ''
                  ).trim();

                return (
                  text === pattern ||
                  text.includes(pattern)
                );

              });

            if (!el) {
              return false;
            }

            el.click();

            return true;

          },
          pattern
        );

      if (result) {
        return true;
      }

    } catch {
    }
  }

  return false;
}


async function checkTruthCheckbox(page) {

  return page.evaluate(() => {

    const boxes =
      Array.from(
        document.querySelectorAll(
          'input[type="checkbox"]'
        )
      );

    if (!boxes.length) {
      return false;
    }

    const checkbox =
      boxes[boxes.length - 1];

    if (!checkbox.checked) {

      checkbox.click();

      checkbox.dispatchEvent(
        new Event(
          'change',
          {
            bubbles: true
          }
        )
      );
    }

    return true;
  });
}


async function attachPdf(
  page,
  filePath
) {

  const inputs =
    await page.$$(
      'input[type="file"]'
    );

  if (!inputs.length) {
    return false;
  }

  await inputs[0].uploadFile(
    filePath
  );

  await new Promise(
    resolve =>
      setTimeout(resolve, 1000)
  );

  return true;
}


async function findAndClickSubmit(page) {

  const buttons =
    await page.$$('button');

  for (
    const button of buttons
  ) {

    try {

      const text =
        await button.evaluate(
          el =>
            (
              el.textContent || ''
            ).trim()
        );

      if (
        text === '등록하기' ||
        text === 'Submit' ||
        text.includes('등록하기')
      ) {

        await button.click();

        return true;
      }

    } catch {
    }
  }

  return false;
}


// ----------------------------------------------------
// 1. 증거 PDF 생성
// ----------------------------------------------------

app.post(
  '/api/capture',
  async (req, res) => {

    let browser = null;

    try {

      const {
        url
      } = req.body;


      if (!url) {

        return res
          .status(400)
          .json({
            error:
              'URL을 입력해주세요.'
          });
      }


      let parsed;

      try {

        parsed =
          new URL(url);

      } catch {

        return res
          .status(400)
          .json({
            error:
              '올바른 URL이 아닙니다.'
          });
      }


      if (
        parsed.protocol !== 'http:' &&
        parsed.protocol !== 'https:'
      ) {

        return res
          .status(400)
          .json({
            error:
              'http 또는 https URL만 가능합니다.'
          });
      }


      browser =
        await launchBrowser();

      const page =
        await browser.newPage();


      await page.setViewport({
        width: 1440,
        height: 1200,
        deviceScaleFactor: 1,
      });


      await page.goto(
        url,
        {
          waitUntil: 'networkidle2',
          timeout: 60000,
        }
      );


      const html =
        await page.content();


      const hash =
        crypto
          .createHash('sha256')
          .update(html)
          .digest('hex');


      const profile =
        SITE_PROFILES[
          parsed.hostname
        ] || {};


      const title =
        cleanText(
          await getText(
            page,
            profile.title
          )
        );


      const author =
        cleanText(
          await getText(
            page,
            profile.author
          )
        );


      const date =
        cleanText(
          await getText(
            page,
            profile.date
          )
        );


      await autoScrollToBottom(
        page
      );


      try {

        await page.addStyleTag({
          url:
            KOREAN_FONT_LINK,
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


        await page.evaluate(
          timeoutMs =>
            Promise.race([
              document.fonts.ready,

              new Promise(resolve =>
                setTimeout(
                  resolve,
                  timeoutMs
                )
              ),
            ]),
          5000
        );

      } catch {
      }


      const evidenceId =
        createEvidenceId();


      const filePath =
        path.join(
          TEMP_DIR,
          `${evidenceId}.pdf`
        );


      const pdfBuffer =
        await page.pdf({

          format: 'A4',

          printBackground: true,

          displayHeaderFooter:
            true,

          headerTemplate: `
            <div style="
              font-size:9px;
              width:100%;
              padding:0 10mm;
              display:flex;
              justify-content:space-between;
              color:#555;
            ">
              <span class="title"></span>
              <span class="date"></span>
            </div>
          `,

          footerTemplate: `
            <div style="
              font-size:9px;
              width:100%;
              padding:0 10mm;
              display:flex;
              justify-content:space-between;
              color:#555;
            ">
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


      fs.writeFileSync(
        filePath,
        pdfBuffer
      );


      const capturedAt =
        new Date().toISOString();


      const evidence = {

        id:
          evidenceId,

        filePath,

        url,

        title,

        author,

        date,

        capturedAt,

        hash,

        confirmed:
          false,

        createdTimestamp:
          Date.now(),
      };


      evidenceStore.set(
        evidenceId,
        evidence
      );


      await browser.close();

      browser = null;


      return res.json({

        success: true,

        evidenceId,

        previewUrl:
          `/api/evidence/${evidenceId}/pdf`,

        downloadUrl:
          `/api/evidence/${evidenceId}/download`,

        metadata: {
          url,
          title,
          author,
          date,
          capturedAt,
          hash,
          channel:
            detectChannel(url),
        },
      });


    } catch (error) {

      console.error(
        'CAPTURE ERROR:',
        error
      );


      if (browser) {

        try {
          await browser.close();
        } catch {
        }
      }


      return res
        .status(500)
        .json({
          error:
            error.message ||
            'PDF 생성 중 오류가 발생했습니다.'
        });
    }
  }
);


// ----------------------------------------------------
// PDF 보기
// ----------------------------------------------------

app.get(
  '/api/evidence/:id/pdf',
  (req, res) => {

    const evidence =
      evidenceStore.get(
        req.params.id
      );


    if (
      !evidence ||
      !fs.existsSync(
        evidence.filePath
      )
    ) {

      return res
        .status(404)
        .send(
          'PDF를 찾을 수 없습니다.'
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


// ----------------------------------------------------
// PDF 다운로드
// ----------------------------------------------------

app.get(
  '/api/evidence/:id/download',
  (req, res) => {

    const evidence =
      evidenceStore.get(
        req.params.id
      );


    if (
      !evidence ||
      !fs.existsSync(
        evidence.filePath
      )
    ) {

      return res
        .status(404)
        .send(
          'PDF를 찾을 수 없습니다.'
        );
    }


    res.download(
      evidence.filePath,
      `evidence_${evidence.id}.pdf`
    );
  }
);


// ----------------------------------------------------
// 증거 확인
// ----------------------------------------------------

app.post(
  '/api/evidence/:id/confirm',
  (req, res) => {

    const evidence =
      evidenceStore.get(
        req.params.id
      );


    if (!evidence) {

      return res
        .status(404)
        .json({
          error:
            '증거자료를 찾을 수 없습니다.'
        });
    }


    evidence.confirmed =
      true;

    evidence.confirmedAt =
      new Date().toISOString();


    return res.json({
      success: true,
      evidenceId:
        evidence.id,
      confirmed: true,
    });
  }
);


// ----------------------------------------------------
// 2. Galaxy 신고폼 자동작성
// ----------------------------------------------------

app.post(
  '/api/report/prepare/:id',
  async (req, res) => {

    const evidence =
      evidenceStore.get(
        req.params.id
      );


    if (!evidence) {

      return res
        .status(404)
        .json({
          error:
            '증거자료를 찾을 수 없습니다.'
        });
    }


    if (!evidence.confirmed) {

      return res
        .status(400)
        .json({
          error:
            '먼저 PDF를 확인해주세요.'
        });
    }


    const stat =
      fs.statSync(
        evidence.filePath
      );


    if (
      stat.size >=
      10 * 1024 * 1024
    ) {

      return res
        .status(400)
        .json({
          error:
            'PDF가 10MB 이상입니다. Galaxy 첨부 제한을 초과합니다.'
        });
    }


    let browser = null;


    try {

      // 기존 신고 세션이 있으면 종료
      const oldSession =
        reportSessions.get(
          evidence.id
        );


      if (oldSession) {

        try {
          await oldSession.browser.close();
        } catch {
        }

        reportSessions.delete(
          evidence.id
        );
      }


      const report =
        req.body || {};


      const reportTitle =
        truncate(
          report.title ||
          evidence.title ||
          '아티스트 권익 침해 게시물 제보',
          40
        );


      const reportContent =
        truncate(
          report.content ||
          `아티스트에 대한 권익 침해가 의심되는 게시물입니다. 원문 전체 내용과 댓글을 PDF 증거자료로 첨부합니다.`,
          1000
        );


      const reportType =
        report.type ||
        '비방·욕설·모욕';


      const channel =
        report.channel ||
        detectChannel(
          evidence.url
        );


      const postDate =
        report.postDate ||
        normalizePostDate(
          evidence.date
        );


      const author =
        truncate(
          report.author ||
          evidence.author ||
          '',
          30
        );


      browser =
        await launchBrowser();


      const page =
        await browser.newPage();


      await page.setViewport({
        width: 1280,
        height: 1200,
        deviceScaleFactor: 1,
      });


      await page.goto(
        GALAXY_URL,
        {
          waitUntil:
            'networkidle2',
          timeout: 60000,
        }
      );


      // 약간 기다림
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1500
          )
      );


      // ------------------------------------------------
      // 구분: G-DRAGON
      // ------------------------------------------------

      let artistResult =
        await selectOptionByText(
          page,
          [
            'G-DRAGON',
            'GDRAGON'
          ]
        );


      if (
        !artistResult.success
      ) {

        await clickCustomOption(
          page,
          [
            'G-DRAGON'
          ]
        );
      }


      // ------------------------------------------------
      // 유형
      // ------------------------------------------------

      const typePatterns = {

        '비방·욕설·모욕': [
          '비방',
          '욕설',
          '모욕',
          'Defamation',
          'Verbal Abuse'
        ],

        '허위사실 유포 및 명예훼손': [
          '허위사실',
          '명예훼손',
          'Spreading False',
          'False Information'
        ],

        '성희롱·성적 모욕': [
          '성희롱',
          '성적 모욕',
          'Sexual Harassment'
        ],

        '초상권·저작권 등 권리 침해': [
          '초상권',
          '저작권',
          'Portrait Rights',
          'Copyright'
        ],

        'AI 딥페이크 및 합성물 악용': [
          '딥페이크',
          '합성물',
          'Deepfake'
        ],

        '기타 권익 침해': [
          '기타 권익',
          'Other Rights',
          'ther Rights'
        ],
      };


      const patterns =
        typePatterns[
          reportType
        ] ||
        typePatterns[
          '비방·욕설·모욕'
        ];


      const typeResult =
        await selectOptionByText(
          page,
          patterns
        );


      if (
        !typeResult.success
      ) {

        await clickCustomOption(
          page,
          patterns
        );
      }


      // ------------------------------------------------
      // 제목
      // ------------------------------------------------

      await setInputByPlaceholder(
        page,
        [
          '주요 내용을',
          'main subject'
        ],
        reportTitle
      );


      // ------------------------------------------------
      // 내용
      // ------------------------------------------------

      await setFirstTextarea(
        page,
        reportContent
      );


      // ------------------------------------------------
      // 채널
      // ------------------------------------------------

      const channelPatterns = {

        dcinside: [
          'dcinside'
        ],

        fmkorea: [
          'fmkorea'
        ],

        Theqoo: [
          'Theqoo',
          'theqoo'
        ],

        instiz: [
          'instiz'
        ],

        Naver: [
          'Naver'
        ],

        Nate: [
          'Nate'
        ],

        'Daum Cafe': [
          'Daum Cafe',
          'Daum'
        ],

        Facebook: [
          'Facebook'
        ],

        Instagram: [
          'Instagram'
        ],

        Threads: [
          'Threads'
        ],

        TikTok: [
          'TikTok'
        ],

        X: [
          'X (Twitter)',
          'Twitter'
        ],

        YouTube: [
          'YouTube'
        ],

        기타: [
          '기타',
          'etc',
          'Other'
        ],
      };


      const channelSearch =
        channelPatterns[channel] ||
        [
          channel
        ];


      const channelResult =
        await selectOptionByText(
          page,
          channelSearch
        );


      if (
        !channelResult.success
      ) {

        await clickCustomOption(
          page,
          channelSearch
        );
      }


      // ------------------------------------------------
      // 날짜
      // ------------------------------------------------

      if (postDate) {

        await setDateInput(
          page,
          postDate
        );
      }


      // ------------------------------------------------
      // URL
      // ------------------------------------------------

      await setInputByPlaceholder(
        page,
        [
          '게시물 url',
          'post url'
        ],
        evidence.url
      );


      // ------------------------------------------------
      // 작성자
      // ------------------------------------------------

      if (author) {

        await setInputByPlaceholder(
          page,
          [
            '닉네임',
            'nickname',
            'id 등'
          ],
          author
        );
      }


      // ------------------------------------------------
      // PDF 자동첨부
      // ------------------------------------------------

      const attached =
        await attachPdf(
          page,
          evidence.filePath
        );


      // ------------------------------------------------
      // 사실확인 체크
      // ------------------------------------------------

      const truthChecked =
        await checkTruthCheckbox(
          page
        );


      // 스크린샷
      const screenshotPath =
        path.join(
          TEMP_DIR,
          `${evidence.id}_galaxy.png`
        );


      await page.screenshot({
        path:
          screenshotPath,

        fullPage: true,
      });


      reportSessions.set(
        evidence.id,
        {
          browser,
          page,
          screenshotPath,
          createdAt:
            Date.now(),

          data: {
            title:
              reportTitle,
            content:
              reportContent,
            type:
              reportType,
            channel,
            postDate,
            author,
            attached,
            truthChecked,
          },
        }
      );


      browser = null;


      return res.json({

        success: true,

        evidenceId:
          evidence.id,

        screenshotUrl:
          `/api/report/screenshot/${evidence.id}`,

        report: {
          artist:
            'G-DRAGON',

          type:
            reportType,

          title:
            reportTitle,

          content:
            reportContent,

          channel,

          postDate,

          url:
            evidence.url,

          author,

          pdfAttached:
            attached,

          truthChecked:
            truthChecked,
        },
      });


    } catch (error) {

      console.error(
        'REPORT PREPARE ERROR:',
        error
      );


      if (browser) {

        try {
          await browser.close();
        } catch {
        }
      }


      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Galaxy 신고서 준비 중 오류가 발생했습니다.'
        });
    }
  }
);


// ----------------------------------------------------
// Galaxy 작성화면 스크린샷
// ----------------------------------------------------

app.get(
  '/api/report/screenshot/:id',
  (req, res) => {

    const session =
      reportSessions.get(
        req.params.id
      );


    if (
      !session ||
      !session.screenshotPath ||
      !fs.existsSync(
        session.screenshotPath
      )
    ) {

      return res
        .status(404)
        .send(
          '신고서 미리보기를 찾을 수 없습니다.'
        );
    }


    res.setHeader(
      'Content-Type',
      'image/png'
    );


    res.sendFile(
      session.screenshotPath
    );
  }
);


// ----------------------------------------------------
// 3. 사용자가 마지막 버튼을 눌렀을 때만 실제 등록
// ----------------------------------------------------

app.post(
  '/api/report/submit/:id',
  async (req, res) => {

    const session =
      reportSessions.get(
        req.params.id
      );


    if (!session) {

      return res
        .status(404)
        .json({
          error:
            'Galaxy 신고 세션이 없습니다. 신고서를 다시 준비해주세요.'
        });
    }


    const {
      browser,
      page
    } = session;


    try {

      // 마지막 순간에 버튼을 서버가 클릭
      const clicked =
        await findAndClickSubmit(
          page
        );


      if (!clicked) {

        return res
          .status(500)
          .json({
            error:
              'Galaxy 등록하기 버튼을 찾지 못했습니다.'
          });
      }


      // 서버 응답/페이지 변화 대기
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            3500
          )
      );


      const currentUrl =
        page.url();


      const pageText =
        await page.evaluate(
          () =>
            (
              document.body.innerText ||
              ''
            ).slice(
              0,
              4000
            )
        );


      const resultScreenshot =
        path.join(
          TEMP_DIR,
          `${req.params.id}_submitted.png`
        );


      await page.screenshot({
        path:
          resultScreenshot,

        fullPage: true,
      });


      const successWords = [
        '접수',
        '완료',
        '감사',
        'submitted',
        'success',
        'thank you',
      ];


      const lower =
        pageText.toLowerCase();


      const successDetected =
        successWords.some(word =>
          lower.includes(
            word.toLowerCase()
          )
        );


      try {

        await browser.close();

      } catch {
      }


      reportSessions.delete(
        req.params.id
      );


      return res.json({

        success: true,

        clicked: true,

        successDetected,

        currentUrl,

        message:
          successDetected
            ? 'Galaxy 등록 요청이 완료되었습니다.'
            : '등록하기 버튼을 눌렀습니다. Galaxy 응답을 확인해주세요.',
      });


    } catch (error) {

      console.error(
        'REPORT SUBMIT ERROR:',
        error
      );


      return res
        .status(500)
        .json({
          error:
            error.message ||
            'Galaxy 등록 중 오류가 발생했습니다.'
        });
    }
  }
);


// ----------------------------------------------------
// 오래된 파일 / 브라우저 세션 정리
// ----------------------------------------------------

setInterval(
  async () => {

    const now =
      Date.now();


    for (
      const [id, evidence]
      of evidenceStore
    ) {

      if (
        now -
        evidence.createdTimestamp >
        EVIDENCE_TTL_MS
      ) {

        try {

          if (
            fs.existsSync(
              evidence.filePath
            )
          ) {

            fs.unlinkSync(
              evidence.filePath
            );
          }

        } catch {
        }


        evidenceStore.delete(
          id
        );
      }
    }


    for (
      const [id, session]
      of reportSessions
    ) {

      if (
        now -
        session.createdAt >
        EVIDENCE_TTL_MS
      ) {

        try {

          await session.browser.close();

        } catch {
        }


        try {

          if (
            session.screenshotPath &&
            fs.existsSync(
              session.screenshotPath
            )
          ) {

            fs.unlinkSync(
              session.screenshotPath
            );
          }

        } catch {
        }


        reportSessions.delete(
          id
        );
      }
    }

  },
  10 * 60 * 1000
);


// ----------------------------------------------------

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Evidence tool server running on port ${PORT}`
    );

  }
);
