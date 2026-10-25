// uuidv7.mjs : identifiants triés par date (RFC 9562), acceptés par --session-id de Gemini CLI.
import { randomBytes } from 'node:crypto';

export function uuidv7() {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6); // 48 bits d'horodatage en millisecondes
  b[6] = (b[6] & 0x0f) | 0x70;     // version 7
  b[8] = (b[8] & 0x3f) | 0x80;     // variante RFC
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
