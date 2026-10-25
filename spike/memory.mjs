// memory.mjs : pic de mémoire résidente d'un processus, échantillonné pendant un tour.
// Linux : le processus et ses descendants (/proc). Windows : le processus (tasklist).
// macOS : le processus (ps). Renvoie null si la mesure est impossible.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

function linuxTreeKb(root) {
  const parent = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      parent.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* processus terminé entre-temps */ }
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) for (const [pid, ppid] of parent) if (ppid === tree[i]) tree.push(pid);
  let kb = 0;
  for (const pid of tree) {
    try { kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0); } catch { /* terminé */ }
  }
  return kb;
}

// Ce que couvre la mesure, pour le rapport
export const MEMORY_SCOPE = {
  linux: 'processus Gemini CLI et ses descendants, toutes les 100 ms',
  win32: 'processus Gemini CLI seul, sans ses commandes shell, toutes les 500 ms',
}[process.platform] ?? 'processus Gemini CLI seul, toutes les 500 ms';

// Dernier champ CSV de tasklist, par exemple "215 432 Ko" ou "215,432 K" : on ne garde que les chiffres
const parseTasklistKb = (csv) => {
  const last = String(csv ?? '').trim().split('","').at(-1) ?? '';
  const digits = last.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
};

export function sampleMemory(pid) {
  let peakKb = 0;
  let timer = null;
  const record = (kb) => { if (kb > peakKb) peakKb = kb; };
  if (pid) {
    if (process.platform === 'linux') {
      const tick = () => record(linuxTreeKb(pid));
      tick();
      timer = setInterval(tick, 100);
    } else {
      const [cmd, args] = process.platform === 'win32'
        ? ['tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']]
        : ['ps', ['-o', 'rss=', '-p', String(pid)]];
      const parse = process.platform === 'win32' ? parseTasklistKb : (out) => Number(String(out).trim()) || 0;
      let busy = false;
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        execFile(cmd, args, { windowsHide: true }, (err, out) => { busy = false; if (!err) record(parse(out)); });
      }, 500);
    }
    timer.unref?.();
  }
  return {
    /** Arrête l'échantillonnage ; pic en Mo, ou null. */
    stop() {
      clearInterval(timer);
      return peakKb ? Math.round(peakKb / 1024) : null;
    },
  };
}

export { parseTasklistKb };
