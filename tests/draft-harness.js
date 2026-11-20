// Test harness: serves a pretend 2027 Sleeper rookie draft through the app's own jget(), so drFind/drPoll/drPayload
// and the 2027 Board run their real code paths. Only the draft endpoints are faked; everything else hits Sleeper.
window.__realJget = window.__realJget || jget;
window.__setupFake = function (opts) {
  const lgKey = opts.lg || 'A', ord = opts.ord, names = opts.names;
  const tp = opts.tp || [];
  const F = window.__FAKE = { lg: lgKey, status: opts.status || 'pre_draft', k: 0, start: Date.now() + 3600e3, ord, names, tp, type: opts.type || 'linear', rounds: opts.rounds || 4, calls: [], raw: opts.raw || null };
  const did = 'FD27' + lgKey, lid = 'FAKE27' + lgKey;
  const draftObj = () => ({ draft_id: did, league_id: lid, season: '2027', type: F.type, status: F.status, start_time: F.start,
    settings: { rounds: F.rounds, teams: 12, player_type: 1 }, slot_to_roster_id: Object.fromEntries(F.ord.map((r, i) => [i + 1, r])) });
  const ownerOf = n => { const r = Math.ceil(n / 12), i = (n - 1) % 12, slot = (F.type === 'snake' && r % 2 === 0) ? 12 - i : i + 1, orig = F.ord[slot - 1];
    const t = F.tp.find(x => x.round === r && x.roster_id === orig); return t ? t.owner_id : orig; };
  jget = async (u) => { F.calls.push(u);
    if (u.startsWith('/user/') && u.endsWith('/leagues/nfl/2027')) return [{ league_id: lid, previous_league_id: LEAGUES[lgKey], name: 'renewal', season: '2027' }];
    if (u === '/league/' + lid + '/drafts') return [draftObj()];
    if (u === '/draft/' + did) return draftObj();
    if (u === '/draft/' + did + '/traded_picks') return F.tp;
    if (u === '/draft/' + did + '/picks') {
      if (F.raw) return F.raw.slice(0, F.k);
      return F.names.slice(0, F.k).map(([nm, pos], i) => { const n = i + 1, [f, ...l] = nm.split(' ');
        return { draft_id: did, pick_no: n, round: Math.ceil(n / 12), draft_slot: (n - 1) % 12 + 1, roster_id: ownerOf(n), player_id: String(9000 + n), metadata: { first_name: f, last_name: l.join(' '), position: pos, team: '' } }; });
    }
    return window.__realJget(u); };
};
