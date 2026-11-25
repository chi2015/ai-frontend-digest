// Run the digest on your machine:  npm run preview  (writes preview.html)  |  npm run send
import { writeFile } from 'node:fs/promises';
import { GET } from '../api/digest.js';

const preview = process.argv[2] === 'preview';
const url = `http://localhost/api/digest${preview ? '?preview=1' : ''}`;
const res = await GET(new Request(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
const body = await res.text();

if (preview && res.ok) {
  await writeFile('preview.html', body);
  console.log('Wrote preview.html — open it in your browser.');
} else {
  console.log(res.status, body);
}
