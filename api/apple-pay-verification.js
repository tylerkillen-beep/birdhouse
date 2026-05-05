const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  const filePath = path.join(process.cwd(), '.well-known', 'apple-developer-merchantid-domain-association');
  const content = fs.readFileSync(filePath);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', content.length);
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.status(200).send(content);
};
