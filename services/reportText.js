function createReportText(data = {}) {

  return `온라인 권익 침해 게시물 증거자료


[게시물 정보]

플랫폼:
${data.channel || ''}


제목:
${data.title || ''}


작성자:
${data.author || ''}


게시일:
${data.postDate || ''}


원본 URL:
${data.url || ''}



[증거 보존 정보]

수집일시:
${data.capturedAt || ''}


첨부파일:
증거 PDF 1부


파일 HASH(SHA256):
${data.hash || ''}
`;

}


module.exports = {
  createReportText
};
