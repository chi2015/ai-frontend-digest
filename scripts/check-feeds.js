// See which feeds work and what got through the filters — no API keys needed:  npm run feeds
import { collectCandidates } from '../api/digest.js';

const { items, report } = await collectCandidates();
console.table(report);
console.log(`\n${items.length} candidate items after date/keyword filtering:\n`);
for (const i of items.slice(0, 40)) console.log(`- [${i.source}] ${i.title}`);
