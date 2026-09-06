/**
 * Тэмцээний прогноз (Монте-Карло) — Engine төлөвөөс: оролцогчид (entrants эсвэл
 * барилдаанд орсон бөх), рейтинг, мэдэгдэж буй үр дүнгүүд. Богино кэштэй.
 */

import type { ForecastDto, MarketRuleDto } from '../app/src/shared/api.ts';
import type { MarketRule } from '../src/domain.ts';
import type { Engine } from '../src/engine.ts';
import { championTop, forecastTournament, matchupProbs, probChampion, type Forecast } from '../src/forecast.ts';
import { titleLabel } from '../src/rating.ts';

const SIMS = 500;

export class ForecastService {
  private readonly engine: Engine;
  private readonly cache = new Map<string, { key: string; f: Forecast; at: number }>();

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** Тэмцээний прогноз (кэш: үр дүн/оролцогч өөрчлөгдөөгүй бол дахин тооцохгүй). */
  forecast(tournamentId: string): Forecast {
    const t = this.engine.tournament(tournamentId);
    const p = this.engine.tournamentProgress(tournamentId);
    const known = this.engine
      .bouts(tournamentId)
      .filter((b) => b.result)
      .map((b) => ({ round: b.round, aId: b.aId, bId: b.bId, winnerId: b.result!.winnerId }));
    const cap = 2 ** t.rounds;
    let entrantIds = t.entrants && t.entrants.length ? t.entrants.slice(0, cap) : [...p.participated];
    // Барилдаанд орсон боловч жагсаалтад байхгүй бөхийг нэмнэ
    const set = new Set(entrantIds);
    for (const id of p.participated) if (!set.has(id)) entrantIds.push(id);
    entrantIds = entrantIds.filter((id) => this.engine.state.wrestlers.has(id));
    let ratingSum = 0;
    for (const id of entrantIds) ratingSum += this.engine.rating(id).rating;
    const key = `${entrantIds.length}|${known.length}|${t.rounds}|${Math.round(ratingSum)}`;
    const cached = this.cache.get(tournamentId);
    if (cached && cached.key === key && Date.now() - cached.at < 5 * 60_000) return cached.f;
    const f = forecastTournament({
      entrants: entrantIds.map((id) => ({ id, rating: this.engine.rating(id).rating })),
      rounds: t.rounds,
      known,
      sims: SIMS,
      seed: 20260816,
    });
    this.cache.set(tournamentId, { key, f, at: Date.now() });
    return f;
  }

  dto(tournamentId: string, options: { top?: number; wrestlerId?: string; aId?: string; bId?: string } = {}): ForecastDto {
    const f = this.forecast(tournamentId);
    const p = this.engine.tournamentProgress(tournamentId);
    const top = options.top ?? 15;
    // Тэмцээн дууссан бол аварга тодорхой: бусдад 0 (сим дуусаагүй салааг тоолохгүй)
    const ranked = f.ids
      .map((id) => ({ id, p: p.championId ? (id === p.championId ? 1 : 0) : probChampion(f, id) }))
      .sort((a, b) => b.p - a.p || (f.expectedWins.get(b.id) ?? 0) - (f.expectedWins.get(a.id) ?? 0))
      .slice(0, top);
    const wr = (id: string) => this.engine.state.wrestlers.get(id);
    const dto: ForecastDto = {
      tournamentId,
      rounds: f.rounds,
      sims: f.sims,
      entrants: f.ids.length,
      knownResults: p.wins.size ? [...p.wins.values()].reduce((a, c) => a + c, 0) : 0,
      finished: p.finished,
      champions: ranked.map((x) => {
        const w = wr(x.id);
        const row: ForecastDto['champions'][number] = {
          id: x.id,
          name: w?.name ?? x.id,
          titleLabel: w ? titleLabel(w.title) : '',
          rating: Math.round(this.engine.rating(x.id).rating),
          pChampion: x.p,
          expectedWins: f.expectedWins.get(x.id) ?? 0,
        };
        if (w?.aimag) row.place = w.sum ? `${w.aimag}, ${w.sum}` : w.aimag;
        const el = f.eliminated.get(x.id);
        if (el !== undefined) row.eliminated = el;
        return row;
      }),
    };
    if (options.wrestlerId && f.winsDist.has(options.wrestlerId)) {
      const w = wr(options.wrestlerId);
      const el = f.eliminated.get(options.wrestlerId);
      dto.wrestler = { id: options.wrestlerId, name: w?.name ?? options.wrestlerId, dist: f.winsDist.get(options.wrestlerId)!, expectedWins: f.expectedWins.get(options.wrestlerId) ?? 0 };
      if (el !== undefined) dto.wrestler.eliminated = el;
    }
    if (options.aId && options.bId) dto.matchup = { aId: options.aId, bId: options.bId, probs: matchupProbs(f, options.aId, options.bId) };
    return dto;
  }

  /** Дүрэмт зах зээлийн анхны магадлал + аваргын жагсаалт. */
  priorFor(rule: MarketRuleDto): { rule: MarketRule; prior: number[]; listed?: string[] } {
    const f = this.forecast(rule.tournamentId);
    if (rule.type === 'wins_over') {
      const d = f.winsDist.get(rule.wrestlerId);
      let over = 0.5;
      if (d) {
        over = 0;
        for (let k = Math.floor(rule.line) + 1; k < d.length; k++) over += d[k]!;
      }
      return { rule: { type: 'wins_over', tournamentId: rule.tournamentId, wrestlerId: rule.wrestlerId, line: rule.line }, prior: [over, 1 - over] };
    }
    if (rule.type === 'wins_exact') {
      const d = f.winsDist.get(rule.wrestlerId) ?? Array.from({ length: f.rounds + 1 }, () => 1 / (f.rounds + 1));
      return { rule: { type: 'wins_exact', tournamentId: rule.tournamentId, wrestlerId: rule.wrestlerId }, prior: d };
    }
    if (rule.type === 'matchup') {
      return { rule: { type: 'matchup', tournamentId: rule.tournamentId, aId: rule.aId, bId: rule.bId }, prior: matchupProbs(f, rule.aId, rule.bId) };
    }
    const top = championTop(f, rule.topK ?? 8);
    return { rule: { type: 'champion', tournamentId: rule.tournamentId }, prior: [...top.probs, top.other], listed: top.ids };
  }
}
