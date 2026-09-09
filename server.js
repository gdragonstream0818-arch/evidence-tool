const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

const PORT = process.env.PORT || 10000;

const CHROME_BIN =
  process.env.CHROME_BIN ||
  '/usr/bin/chromium';

const GALAXY_URL =
  'https://protect.galaxyuniverse.ai/rights-violations/new';

const TEMP_DIR =
  path.join(
    os.tmpdir(),
    'evidence-tool'
  );

const EVIDENCE_TTL =
  60 * 60 * 1000;


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



const evidenceStore =
  new Map();



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
  )
  .slice(
    0,
    length
  );

}



function getProfile(urlString) {

  try {

    return SITE_PROFILES[
      new URL(urlString).hostname
    ] || null;

  } catch {

    return null;

  }

}



function detectChannel(urlString) {

  return (
    getProfile(urlString)?.channel ||
    '기타'
  );

}



function normalizeDate(value) {

  const match =
    String(value || '')
    .match(
      /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/
    );


  if (!match) {

    return '';

  }


  return (
    `${match[1]}-` +
    `${match[2].padStart(2,'0')}-` +
    `${match[3].padStart(2,'0')}`
  );

}




async function getText(
  page,
  selector
) {

  if (!selector) {

    return '';

  }


  try {

    return cleanText(
      await page.$eval(
        selector,
        el =>
          el.innerText ||
          el.textContent ||
          ''
      )
    );

  } catch {

    return '';

  }

}





let browserPromise = null;



async function getBrowser() {


  if (!browserPromise) {


    browserPromise =
      puppeteer.launch({

        executablePath:
          CHROME_BIN,


        headless:
          true,


        args: [

          '--no-sandbox',

          '--disable-setuid-sandbox',

          '--disable-dev-shm-usage',

          '--disable-gpu',

          '--no-first-run',

          '--no-zygote'

        ]

      });


    browserPromise
      .then(browser => {

        browser.on(
          'disconnected',
          () => {

            browserPromise = null;

          }
        );

      })
      .catch(() => {

        browserPromise = null;

      });

  }


  return browserPromise;

}





async function quickScroll(page) {


  await page.evaluate(

    async () => {


      const wait =
        ms =>
          new Promise(
            r => setTimeout(r, ms)
          );


      for (
        let i = 0;
        i < 12;
        i++
      ) {


        window.scrollBy(
          0,
          window.innerHeight * 1.5
        );


        await wait(80);


      }


      window.scrollTo(
        0,
        0
      );


    }

  );

}

// ------------------------------------------------
// 증거 PDF 생성
// ------------------------------------------------


app.post(
  '/api/capture',
  async (req, res) => {


    let page;


    try {


      const url =
        req.body?.url;


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



      const browser =
        await getBrowser();



      page =
        await browser.newPage();



      await page.setViewport({

        width:
          1280,

        height:
          900,

        deviceScaleFactor:
          1

      });



      page.setDefaultNavigationTimeout(
        60000
      );



      await page.goto(
        url,
        {

          waitUntil:
            'domcontentloaded',

          timeout:
            60000

        }
      );



      await new Promise(
        r =>
          setTimeout(
            r,
            800
          )
      );



      await quickScroll(
        page
      );



      await new Promise(
        r =>
          setTimeout(
            r,
            250
          )
      );



      const profile =
        getProfile(
          url
        );



      const title =
        await getText(
          page,
          profile?.title
        );


      const author =
        await getText(
          page,
          profile?.author
        );


      const date =
        await getText(
          page,
          profile?.date
        );



      const id =
        crypto.randomUUID();



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


        headerTemplate:

          `
          <div style="
          font-size:8px;
          width:100%;
          padding:0 10mm;
          color:#555">

          <span class="title"></span>

          </div>
          `,


        footerTemplate:

          `
          <div style="
          font-size:8px;
          width:100%;
          padding:0 10mm;
          display:flex;
          justify-content:space-between;
          color:#555">

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




      const hash =
        crypto
          .createHash(
            'sha256'
          )
          .update(
            fs.readFileSync(
              pdfPath
            )
          )
          .digest(
            'hex'
          );




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



    } catch(error) {


      console.error(
        'Capture error:',
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


      if(page) {

        try {

          await page.close();

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
  (req,res)=>{


    const evidence =
      evidenceStore.get(
        req.params.id
      );



    if(
      !evidence ||
      !fs.existsSync(
        evidence.pdfPath
      )
    ){

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
    )
    .pipe(
      res
    );

  }

);





app.get(
  '/api/evidence/:id/download',
  (req,res)=>{


    const evidence =
      evidenceStore.get(
        req.params.id
      );



    if(
      !evidence ||
      !fs.existsSync(
        evidence.pdfPath
      )
    ){

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





app.post(
  '/api/evidence/:id/confirm',
  (req,res)=>{


    const evidence =
      evidenceStore.get(
        req.params.id
      );



    if(!evidence){

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
// Galaxy 신고 데이터 생성
// ------------------------------------------------


app.post(
  '/api/report/prepare/:id',
  (req,res)=>{


    const evidence =
      evidenceStore.get(
        req.params.id
      );



    if(!evidence){

      return res
        .status(404)
        .json({

          error:
            '증거자료를 찾을 수 없습니다.'

        });

    }



    if(!evidence.confirmed){

      return res
        .status(400)
        .json({

          error:
            '먼저 PDF 확인을 완료해주세요.'

        });

    }



    if(
      !fs.existsSync(
        evidence.pdfPath
      )
    ){

      return res
        .status(404)
        .json({

          error:
            'PDF 파일을 찾을 수 없습니다.'

        });

    }



    if(
      fs.statSync(
        evidence.pdfPath
      ).size >
      10 * 1024 * 1024
    ){

      return res
        .status(400)
        .json({

          error:
            'PDF 용량이 10MB를 초과합니다.'

        });

    }



    const body =
      req.body || {};



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

`
온라인 권익 침해 게시물 증거자료입니다.

[게시물 정보]

플랫폼:
${evidence.channel || ''}

제목:
${evidence.title || ''}

작성자:
${evidence.author || ''}

게시일:
${evidence.date || ''}

원본 URL:
${evidence.url || ''}


[증거 보존 정보]

수집일시:
${evidence.capturedAt || ''}

첨부 PDF:
증거자료 첨부

증거파일 HASH(SHA256):
${evidence.hash || ''}
`,

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

        evidence.url

    };




    return res.json({

      success:
        true,


      galaxyUrl:
        GALAXY_URL,


      // 기존 프론트 오류 방지용

      remoteUrl:
        GALAXY_URL,


      report,


      evidence: {

        id:
          evidence.id,


        pdfUrl:

          `/api/evidence/${evidence.id}/download`

      }

    });


  }

);






// ------------------------------------------------
// 오래된 PDF 자동 삭제
// ------------------------------------------------


setInterval(

  ()=>{


    const now =
      Date.now();



    for(
      const [
        id,
        evidence
      ]
      of evidenceStore
    ){



      if(
        now -
        evidence.createdAt
        >
        EVIDENCE_TTL
      ){


        try{


          if(
            fs.existsSync(
              evidence.pdfPath
            )
          ){

            fs.unlinkSync(
              evidence.pdfPath
            );

          }


        }catch{}



        evidenceStore.delete(
          id
        );


      }


    }


  },

  10 * 60 * 1000

);






// ------------------------------------------------
// 서버 실행
// ------------------------------------------------


app.listen(

  PORT,

  '0.0.0.0',

  ()=>{


    console.log(
      `Evidence tool running on port ${PORT}`
    );


  }

);
