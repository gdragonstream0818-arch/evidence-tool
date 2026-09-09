const express = require('express');
const cors = require('cors');

const puppeteer = require('puppeteer-core');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  createReportText
} = require('./services/reportText');

const http = require('http');
const net = require('net');

const WebSocket = require('ws');


const app = express();

const server = http.createServer(app);


const PORT =
  process.env.PORT ||
  10000;


const CHROME_BIN =
  process.env.CHROME_BIN ||
  '/usr/bin/chromium';


const DISPLAY =
  process.env.DISPLAY ||
  ':99';


const GALAXY_URL =
  'https://protect.galaxyuniverse.ai/rights-violations/new';


const TEMP_DIR =
  path.join(
    os.tmpdir(),
    'evidence-tool'
  );


fs.mkdirSync(
  TEMP_DIR,
  {
    recursive: true
  }
);


app.use(
  cors()
);


app.use(
  express.json({
    limit: '2mb'
  })
);


app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


// noVNC 파일 제공
app.use(
  '/novnc',
  express.static(
    '/usr/share/novnc'
  )
);


const evidenceStore =
  new Map();


const reportSessions =
  new Map();


const EVIDENCE_TTL =
  60 * 60 * 1000;


// ------------------------------------------------
// 사이트 설정
// ------------------------------------------------

const SITE_PROFILES = {

  'gall.dcinside.com': {

    title:
      '.title_subject',

    author:
      '.gall_writer .nickname',

    date:
      '.gall_date',

    channel:
      'dcinside'
  },


  'fmkorea.com': {

    title:
      '.np_18px, .title',

    author:
      '.member_plate, .top_content .author',

    date:
      '.date.m_no',

    channel:
      'fmkorea'
  },


  'www.fmkorea.com': {

    title:
      '.np_18px, .title',

    author:
      '.member_plate, .top_content .author',

    date:
      '.date.m_no',

    channel:
      'fmkorea'
  }

};


// ------------------------------------------------
// 공통 함수
// ------------------------------------------------

function randomId() {

  return crypto
    .randomUUID();
}


function cleanText(value) {

  return String(
    value || ''
  )
    .replace(
      /\s+/g,
      ' '
    )
    .trim();
}


function truncate(
  value,
  length
) {

  return cleanText(
    value
  ).slice(
    0,
    length
  );
}


function getProfile(urlString) {

  try {

    const url =
      new URL(
        urlString
      );

    return (
      SITE_PROFILES[
        url.hostname
      ] ||
      null
    );

  } catch {

    return null;
  }
}


function detectChannel(
  urlString
) {

  const profile =
    getProfile(
      urlString
    );

  return (
    profile?.channel ||
    '기타'
  );
}


function normalizeDate(
  value
) {

  if (!value) {
    return '';
  }


  const match =
    String(
      value
    ).match(
      /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/
    );


  if (!match) {
    return '';
  }


  return (
    `${match[1]}-` +
    `${match[2].padStart(2, '0')}-` +
    `${match[3].padStart(2, '0')}`
  );
}


// ------------------------------------------------
// Chrome 실행
// ------------------------------------------------

async function launchHeadlessBrowser() {

  return puppeteer.launch({

    executablePath:
      CHROME_BIN,

    headless:
      true,

    args: [

      '--no-sandbox',

      '--disable-setuid-sandbox',

      '--disable-dev-shm-usage',

      '--disable-gpu',

      '--window-size=1280,900'
    ]
  });
}


async function launchVisibleBrowser() {

  return puppeteer.launch({

    executablePath:
      CHROME_BIN,

    headless:
      false,

    env: {

      ...process.env,

      DISPLAY
    },

    args: [

      '--no-sandbox',

      '--disable-setuid-sandbox',

      '--disable-dev-shm-usage',

      '--disable-gpu',

      '--window-size=1280,900',

      '--start-maximized'
    ],

    defaultViewport:
      null
  });
}


// ------------------------------------------------
// 페이지 자동 스크롤
// ------------------------------------------------

async function autoScroll(
  page
) {

  await page.evaluate(
    async () => {

      await new Promise(
        resolve => {

          let count =
            0;

          const timer =
            setInterval(
              () => {

                window.scrollBy(
                  0,
                  700
                );

                count++;


                if (
                  count >= 30 ||
                  (
                    window.innerHeight +
                    window.scrollY
                  ) >=
                  document.body.scrollHeight
                ) {

                  clearInterval(
                    timer
                  );

                  resolve();
                }

              },
              150
            );
        }
      );
    }
  );


  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        600
      )
  );
}


// ------------------------------------------------
// 텍스트 가져오기
// ------------------------------------------------

async function getText(
  page,
  selector
) {

  if (!selector) {
    return '';
  }


  try {

    return await page.$eval(
      selector,
      element =>
        (
          element.innerText ||
          element.textContent ||
          ''
        ).trim()
    );

  } catch {

    return '';
  }
}


// ------------------------------------------------
// 증거 PDF 생성
// ------------------------------------------------

app.post(
  '/api/capture',
  async (
    req,
    res
  ) => {

    let browser;


    try {

      const {
        url
      } =
        req.body;


      if (!url) {

        return res
          .status(400)
          .json({
            error:
              'URL을 입력해주세요.'
          });
      }


      const parsed =
        new URL(
          url
        );


      if (
        ![
          'http:',
          'https:'
        ].includes(
          parsed.protocol
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              '지원하지 않는 URL입니다.'
          });
      }


      browser =
        await launchHeadlessBrowser();


      const page =
        await browser.newPage();


      await page.setViewport({

        width:
          1280,

        height:
          900,

        deviceScaleFactor:
          1
      });


      await page.goto(
        url,
        {

          waitUntil:
            'networkidle2',

          timeout:
            60000
        }
      );


      const html =
        await page.content();


      const hash =
        crypto
          .createHash(
            'sha256'
          )
          .update(
            html
          )
          .digest(
            'hex'
          );


      const profile =
        getProfile(
          url
        );


      const title =
        cleanText(
          await getText(
            page,
            profile?.title
          )
        );


      const author =
        cleanText(
          await getText(
            page,
            profile?.author
          )
        );


      const date =
        cleanText(
          await getText(
            page,
            profile?.date
          )
        );


      await autoScroll(
        page
      );


      await page.evaluate(
        () => {

          window.scrollTo(
            0,
            0
          );
        }
      );


      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            500
          )
      );


      const id =
        randomId();


      const pdfPath =
        path.join(
          TEMP_DIR,
          `${id}.pdf`
        );


      await page.pdf({

        path:
          pdfPath,

        format:
          'A4',

        printBackground:
          true,

        displayHeaderFooter:
          true,

        headerTemplate: `

          <div
            style="
              font-size:8px;
              width:100%;
              padding:0 10mm;
              color:#555;
            "
          >

            <span class="title"></span>

          </div>

        `,

        footerTemplate: `

          <div
            style="
              font-size:8px;
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

          top:
            '18mm',

          bottom:
            '18mm',

          left:
            '10mm',

          right:
            '10mm'
        }
      });


      const evidence = {

        id,

        pdfPath,

        url,

        title,

        author,

        date,

        channel:
          detectChannel(
            url
          ),

        hash,

        capturedAt:
          new Date()
            .toISOString(),

        confirmed:
          false,

        createdAt:
          Date.now()
      };


      evidenceStore.set(
        id,
        evidence
      );


      return res.json({

        success:
          true,

        evidenceId:
          id,

        previewUrl:
          `/api/evidence/${id}/pdf`,

        downloadUrl:
          `/api/evidence/${id}/download`,

        metadata: {

          url,

          title,

          author,

          date,

          channel:
            evidence.channel,

          capturedAt:
            evidence.capturedAt,

          hash
        }
      });


    } catch (error) {

      console.error(
        error
      );


      return res
        .status(500)
        .json({

          error:
            error.message ||
            '증거 수집 중 오류가 발생했습니다.'
        });


    } finally {

      if (browser) {

        try {

          await browser.close();

        } catch {}
      }
    }
  }
);


// ------------------------------------------------
// PDF 보기
// ------------------------------------------------

app.get(
  '/api/evidence/:id/pdf',
  (
    req,
    res
  ) => {

    const evidence =
      evidenceStore.get(
        req.params.id
      );


    if (
      !evidence ||
      !fs.existsSync(
        evidence.pdfPath
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


    fs.createReadStream(
      evidence.pdfPath
    ).pipe(
      res
    );
  }
);


app.get(
  '/api/evidence/:id/download',
  (
    req,
    res
  ) => {

    const evidence =
      evidenceStore.get(
        req.params.id
      );


    if (!evidence) {

      return res
        .status(404)
        .send(
          '증거자료를 찾을 수 없습니다.'
        );
    }


    res.download(
      evidence.pdfPath,
      `evidence_${evidence.id}.pdf`
    );
  }
);


// ------------------------------------------------
// PDF 확인
// ------------------------------------------------

app.post(
  '/api/evidence/:id/confirm',
  (
    req,
    res
  ) => {

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


    return res.json({
      success:
        true
    });
  }
);


// ------------------------------------------------
// Galaxy 자동입력 보조
// ------------------------------------------------

async function setInputByPlaceholder(
  page,
  words,
  value
) {

  if (!value) {
    return false;
  }


  return page.evaluate(
    (
      patterns,
      text
    ) => {

      const inputs =
        [
          ...document.querySelectorAll(
            'input'
          )
        ];


      const input =
        inputs.find(
          element => {

            const placeholder =
              (
                element.placeholder ||
                ''
              ).toLowerCase();


            return patterns.some(
              word =>
                placeholder.includes(
                  word.toLowerCase()
                )
            );
          }
        );


      if (!input) {
        return false;
      }


      const setter =
        Object
          .getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
          )
          ?.set;


      if (setter) {

        setter.call(
          input,
          text
        );

      } else {

        input.value =
          text;
      }


      input.dispatchEvent(
        new Event(
          'input',
          {
            bubbles: true
          }
        )
      );


      input.dispatchEvent(
        new Event(
          'change',
          {
            bubbles: true
          }
        )
      );


      return true;

    },

    words,

    value
  );
}


async function setTextarea(
  page,
  value
) {

  if (!value) {
    return false;
  }


  return page.evaluate(
    text => {

      const area =
        document.querySelector(
          'textarea'
        );


      if (!area) {
        return false;
      }


      const setter =
        Object
          .getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          )
          ?.set;


      if (setter) {

        setter.call(
          area,
          text
        );

      } else {

        area.value =
          text;
      }


      area.dispatchEvent(
        new Event(
          'input',
          {
            bubbles: true
          }
        )
      );


      area.dispatchEvent(
        new Event(
          'change',
          {
            bubbles: true
          }
        )
      );


      return true;
    },

    value
  );
}


async function setDateInput(
  page,
  value
) {

  if (!value) {
    return false;
  }


  return page.evaluate(
    text => {

      const input =
        document.querySelector(
          'input[type="date"]'
        );


      if (!input) {
        return false;
      }


      input.value =
        text;


      input.dispatchEvent(
        new Event(
          'input',
          {
            bubbles: true
          }
        )
      );


      input.dispatchEvent(
        new Event(
          'change',
          {
            bubbles: true
          }
        )
      );


      return true;
    },

    value
  );
}


async function selectNativeOption(
  page,
  patterns
) {

  return page.evaluate(
    list => {

      const selects =
        [
          ...document.querySelectorAll(
            'select'
          )
        ];


      for (
        const select
        of selects
      ) {

        const option =
          [
            ...select.options
          ].find(
            item => {

              const text =
                (
                  item.textContent ||
                  ''
                ).trim()
                  .toLowerCase();


              return list.some(
                pattern =>
                  text.includes(
                    pattern.toLowerCase()
                  )
              );
            }
          );


        if (option) {

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


          return true;
        }
      }


      return false;

    },

    patterns
  );
}


// ------------------------------------------------
// Galaxy 실제 브라우저 세션 준비
// ------------------------------------------------

app.post(
  '/api/report/prepare/:id',
  async (
    req,
    res
  ) => {

    let browser;


    try {

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
              '먼저 PDF 확인을 완료해주세요.'
          });
      }


      const fileSize =
        fs.statSync(
          evidence.pdfPath
        ).size;


      if (
        fileSize >
        10 * 1024 * 1024
      ) {

        return res
          .status(400)
          .json({
            error:
              'PDF 용량이 10MB를 초과합니다.'
          });
      }


      // 기존 세션 종료
      for (
        const [
          token,
          session
        ]
        of reportSessions
      ) {

        try {

          await session.browser.close();

        } catch {}


        reportSessions.delete(
          token
        );
      }


      const body =
        req.body ||
        {};


      const report = {

        type:
          body.type ||
          '비방·욕설·모욕',

        title:
          truncate(
            body.title ||
            evidence.title ||
            '아티스트 권익 침해 게시물 제보',
            40
          ),

        content:
          truncate(
            body.content ||
            '아티스트에 대한 권익 침해가 의심되는 게시물입니다. 원문 전체 내용과 댓글을 PDF 증거자료로 첨부합니다.',
            1000
          ),

        channel:
          body.channel ||
          evidence.channel,

        postDate:
          body.postDate ||
          normalizeDate(
            evidence.date
          ),

        author:
          truncate(
            body.author ||
            evidence.author,
            30
          ),

        url:
  evidence.url,


capturedAt:
  evidence.capturedAt,


hash:
  evidence.hash,


reportText:
  createReportText({

    channel:
      evidence.channel,

    title:
      evidence.title,

    author:
      evidence.author,

    postDate:
      report.postDate,

    url:
      evidence.url,

    capturedAt:
      evidence.capturedAt,

    hash:
      evidence.hash

  })

};


      browser =
        await launchVisibleBrowser();


      const pages =
        await browser.pages();


      const page =
        pages[0] ||
        await browser.newPage();


      await page.goto(
        GALAXY_URL,
        {

          waitUntil:
            'domcontentloaded',

          timeout:
            60000
        }
      );


      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            2500
          )
      );


      // native select일 경우 자동입력 시도
      await selectNativeOption(
        page,
        [
          'G-DRAGON',
          '지드래곤'
        ]
      );


      await selectNativeOption(
        page,
        [
          report.type,
          'Defamation',
          'Verbal Abuse'
        ]
      );


      await selectNativeOption(
        page,
        [
          report.channel
        ]
      );


      // 제목
      await setInputByPlaceholder(
        page,
        [
          'title',
          '제목'
        ],
        report.title
      );


      // 내용
      await setTextarea(
        page,
        report.content
      );


      // URL
      await setInputByPlaceholder(
        page,
        [
          'url',
          '링크'
        ],
        report.url
      );


      // 작성자
      await setInputByPlaceholder(
        page,
        [
          'author',
          '작성자',
          'nickname'
        ],
        report.author
      );


      // 게시 날짜
      await setDateInput(
        page,
        report.postDate
      );


      // PDF 첨부
      let pdfAttached =
        false;


      const fileInputs =
        await page.$$(
          'input[type="file"]'
        );


      if (
        fileInputs.length > 0
      ) {

        await fileInputs[0]
          .uploadFile(
            evidence.pdfPath
          );


        pdfAttached =
          true;


        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1500
            )
        );
      }


      const token =
        crypto
          .randomBytes(
            24
          )
          .toString(
            'hex'
          );


      reportSessions.set(
        token,
        {

          token,

          evidenceId:
            evidence.id,

          browser,

          page,

          createdAt:
            Date.now(),

          lastActive:
            Date.now()
        }
      );


      browser =
        null;


      return res.json({

        success:
          true,

        sessionToken:
          token,

        remoteUrl:
          `/remote.html?session=${token}`,

        pdfAttached,

        report
      });


    } catch (error) {

      console.error(
        'Galaxy prepare error:',
        error
      );


      if (browser) {

        try {

          await browser.close();

        } catch {}
      }


      return res
        .status(500)
        .json({

          error:
            error.message ||
            'Galaxy 신고 페이지를 열 수 없습니다.'
        });
    }
  }
);


// ------------------------------------------------
// 세션 유효성 검사
// ------------------------------------------------

app.get(
  '/api/report/session/:token',
  (
    req,
    res
  ) => {

    const session =
      reportSessions.get(
        req.params.token
      );


    if (!session) {

      return res
        .status(404)
        .json({
          active:
            false
        });
    }


    session.lastActive =
      Date.now();


    return res.json({
      active:
        true
    });
  }
);


// ------------------------------------------------
// 세션 종료
// ------------------------------------------------

app.post(
  '/api/report/close/:token',
  async (
    req,
    res
  ) => {

    const session =
      reportSessions.get(
        req.params.token
      );


    if (session) {

      try {

        await session.browser.close();

      } catch {}


      reportSessions.delete(
        req.params.token
      );
    }


    return res.json({
      success:
        true
    });
  }
);


// ------------------------------------------------
// VNC WebSocket 브리지
// ------------------------------------------------

const wss =
  new WebSocket.Server({

    noServer:
      true,

    handleProtocols:
      protocols => {

        if (
          protocols.has(
            'binary'
          )
        ) {

          return 'binary';
        }


        return false;
      }
  });


server.on(
  'upgrade',
  (
    request,
    socket,
    head
  ) => {

    try {

      const url =
        new URL(
          request.url,
          `http://${request.headers.host}`
        );


      if (
        url.pathname !==
        '/vnc-ws'
      ) {

        socket.destroy();

        return;
      }


      const token =
        url.searchParams.get(
          'session'
        );


      if (
        !token ||
        !reportSessions.has(
          token
        )
      ) {

        socket.destroy();

        return;
      }


      const session =
        reportSessions.get(
          token
        );


      session.lastActive =
        Date.now();


      wss.handleUpgrade(
        request,
        socket,
        head,
        ws => {

          const tcp =
            net.createConnection(
              {

                host:
                  '127.0.0.1',

                port:
                  5900
              }
            );


          tcp.on(
            'data',
            data => {

              if (
                ws.readyState ===
                WebSocket.OPEN
              ) {

                ws.send(
                  data
                );
              }
            }
          );


          ws.on(
            'message',
            data => {

              if (
                !tcp.destroyed
              ) {

                tcp.write(
                  data
                );
              }
            }
          );


          ws.on(
            'close',
            () => {

              tcp.destroy();
            }
          );


          ws.on(
            'error',
            () => {

              tcp.destroy();
            }
          );


          tcp.on(
            'close',
            () => {

              try {

                ws.close();

              } catch {}
            }
          );


          tcp.on(
            'error',
            () => {

              try {

                ws.close();

              } catch {}
            }
          );

        }
      );


    } catch {

      socket.destroy();
    }
  }
);


// ------------------------------------------------
// 오래된 자료 정리
// ------------------------------------------------

setInterval(
  async () => {

    const now =
      Date.now();


    for (
      const [
        id,
        evidence
      ]
      of evidenceStore
    ) {

      if (
        now -
        evidence.createdAt >
        EVIDENCE_TTL
      ) {

        try {

          if (
            fs.existsSync(
              evidence.pdfPath
            )
          ) {

            fs.unlinkSync(
              evidence.pdfPath
            );
          }

        } catch {}


        evidenceStore.delete(
          id
        );
      }
    }


    for (
      const [
        token,
        session
      ]
      of reportSessions
    ) {

      if (
        now -
        session.lastActive >
        EVIDENCE_TTL
      ) {

        try {

          await session.browser.close();

        } catch {}


        reportSessions.delete(
          token
        );
      }
    }

  },

  10 * 60 * 1000
);


// ------------------------------------------------
// 서버 실행
// ------------------------------------------------

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Evidence tool running on port ${PORT}`
    );

    console.log(
      `DISPLAY = ${DISPLAY}`
    );
  }
);
