/**
 * Бооцооны самбар — тэмцээний тухайн давааны бүх хосыг нэг дэлгэцэд.
 *
 * Хос бүрийн А/Б бөх дээр дарж сонгоно → мөрөнд дүн (100/500/1 000/5 000/өөрөө) →
 * доод «Тавих» нэг товчоор бүгдийг тавина (тус бүр дан бооцоо, LMSR зах зээл дээр).
 * Хувь = зах зээлийн магадлал, ×коэфф. = 1/магадлал (спот), «загвар» = Elo магадлал.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, ApiError, newRequestId } from '../api';
import { Button, Card, Loading, Msg, P, Pill, Row } from '../components/ui';
import { fmtPct, fmtTokens } from '../format';
import type { BatchBuyOrder, BatchBuyResultDto, BoardBoutDto, BoardDto, MeDto, QuoteDto } from '../shared/api';
import { theme } from '../theme';

const QUICK = [100, 500, 1000, 5000];
const MIN_BET = 10;
const MAX_BET = 5000;

interface BetPick {
  outcome: 0 | 1;
  stake: number;
}

function odds(p: number): string {
  if (p <= 0) return '—';
  return `×${(1 / p).toFixed(2)}`;
}

/** Хосын нэг тал (А эсвэл Б) — дарж сонгох товч. */
function Side({
  bout,
  which,
  pick,
  onPress,
}: {
  bout: BoardBoutDto;
  which: 0 | 1;
  pick: BetPick | undefined;
  onPress: () => void;
}) {
  const w = which === 0 ? bout.a : bout.b;
  const p = bout.probs[which];
  const model = bout.model[which];
  const selected = pick?.outcome === which;
  const resolved = bout.status === 'resolved' || bout.status === 'voided';
  const won = bout.winnerId === w.id;
  const lost = resolved && bout.winnerId !== undefined && !won;
  const mine = bout.myShares?.[which] ?? 0;
  const tradable = bout.status === 'open';
  return (
    <Pressable
      onPress={onPress}
      disabled={!tradable}
      accessibilityRole="button"
      style={({ pressed }) => [
        s.side,
        which === 1 && s.sideRight,
        selected && s.sideSelected,
        won && s.sideWon,
        lost && { opacity: 0.45 },
        pressed && tradable && { opacity: 0.8 },
      ]}
    >
      <Text style={[s.name, selected && { color: theme.accentText }, won && { color: '#052e16' }]} numberOfLines={1}>
        {w.name}
      </Text>
      <Text style={[s.sub, selected && { color: theme.accentText }, won && { color: '#052e16' }]} numberOfLines={2}>
        {[w.titleLabel, w.place].filter(Boolean).join(' · ')}
      </Text>
      <Row style={{ justifyContent: which === 0 ? 'flex-start' : 'flex-end' }} gap={6}>
        <Text style={[s.pct, selected && { color: theme.accentText }, won && { color: '#052e16' }]}>{fmtPct(p)}</Text>
        <Text style={[s.odds, selected && { color: theme.accentText }, won && { color: '#052e16' }]}>{odds(p)}</Text>
        <Text style={[s.model, selected && { color: theme.accentText }, won && { color: '#052e16' }]}>загвар {fmtPct(model)}</Text>
      </Row>
      {won ? <Text style={s.wonTag}>✓ давсан</Text> : null}
      {mine > 0.5 ? (
        <Text style={[s.mine, selected && { color: theme.accentText }]}>
          {resolved ? (won ? `+${fmtTokens(mine)} авсан` : 'миний бооцоо унасан') : `миний ${fmtTokens(mine)} хувь`}
        </Text>
      ) : null}
      {selected ? <Text style={s.selTag}>сонгосон ✓</Text> : null}
    </Pressable>
  );
}

function PairRow({
  bout,
  index,
  pick,
  onToggle,
  onStake,
  onOpenMarket,
}: {
  bout: BoardBoutDto;
  index: number;
  pick: BetPick | undefined;
  onToggle: (which: 0 | 1) => void;
  onStake: (stake: number) => void;
  onOpenMarket: (id: string) => void;
}) {
  const [custom, setCustom] = useState('');
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const p = pick ? bout.probs[pick.outcome] : 0;
  const est = pick && p > 0 ? Math.round(pick.stake / p) : 0;
  // Бодит санал (LMSR гулсалттай): сонголт/дүн өөрчлөгдөхөд серверээс авна
  useEffect(() => {
    if (!pick || !bout.marketId) {
      setQuote(null);
      return;
    }
    let alive = true;
    const marketId = bout.marketId;
    const t = setTimeout(() => {
      api<QuoteDto>(`/api/markets/${marketId}/quote`, { body: { outcome: pick.outcome, spend: pick.stake } })
        .then((q) => alive && setQuote(q))
        .catch(() => alive && setQuote(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pick?.outcome, pick?.stake, bout.marketId, bout.probs[0]]);
  const payout = quote && quote.outcome === pick?.outcome && quote.spend === pick?.stake ? quote.payoutIfWin : est;
  const mult = quote && quote.outcome === pick?.outcome && quote.spend === pick?.stake ? quote.multiplier : p > 0 ? 1 / p : 0;
  return (
    <View style={s.pair}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={s.pairNo}>
          №{index + 1} · {bout.round}-р даваа
        </Text>
        <Row gap={6}>
          {bout.status === 'open' ? <Pill text="нээлттэй" color={theme.success} textColor="#052e16" /> : null}
          {bout.status === 'closed' ? <Pill text="хаагдсан" color={theme.warn} textColor="#1a1300" /> : null}
          {bout.status === 'voided' ? <Pill text="хүчингүй" /> : null}
          {bout.status === 'none' ? <Pill text="зах зээлгүй" /> : null}
          {bout.volume > 0 ? <Text style={s.vol}>эргэлт {fmtTokens(bout.volume)}</Text> : null}
        </Row>
      </Row>
      <View style={s.sides}>
        <Side bout={bout} which={0} pick={pick} onPress={() => onToggle(0)} />
        <Text style={s.vs}>—</Text>
        <Side bout={bout} which={1} pick={pick} onPress={() => onToggle(1)} />
      </View>
      {pick ? (
        <View style={s.stakeRow}>
          <Text style={s.stakeLabel}>Дүн:</Text>
          {QUICK.map((q) => (
            <Pressable key={q} onPress={() => onStake(q)} style={[s.chip, pick.stake === q && s.chipOn]} accessibilityRole="button">
              <Text style={[s.chipText, pick.stake === q && { color: theme.accentText }]}>{fmtTokens(q)}</Text>
            </Pressable>
          ))}
          <TextInput
            value={custom}
            onChangeText={(v) => {
              setCustom(v);
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= MIN_BET && n <= MAX_BET) onStake(n);
            }}
            placeholder="өөр"
            placeholderTextColor={theme.muted}
            keyboardType="numeric"
            style={s.customInput}
          />
          <Text style={s.est}>
            → давбал <Text style={{ color: theme.success, fontWeight: '800' }}>{fmtTokens(payout)}</Text> (×{mult.toFixed(2)})
          </Text>
        </View>
      ) : null}
      {bout.marketId ? (
        <Text style={s.more} onPress={() => onOpenMarket(bout.marketId!)}>
          Дэлгэрэнгүй › (хоорондын харьцаа, кэш-аут)
        </Text>
      ) : null}
    </View>
  );
}

export function BoardScreen({
  tournamentId,
  me,
  refreshKey,
  onBack,
  onOpenMarket,
  onTraded,
}: {
  tournamentId: string;
  me: MeDto;
  refreshKey: number;
  onBack: () => void;
  onOpenMarket: (id: string) => void;
  onTraded: (balance: number) => void;
}) {
  const [data, setData] = useState<BoardDto | null>(null);
  const [round, setRound] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [picks, setPicks] = useState<Map<string, BetPick>>(new Map());
  const [lastStake, setLastStake] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const requestIds = useRef<Map<string, string>>(new Map());

  const load = async (r: number | undefined) => {
    try {
      const d = await api<BoardDto>(`/api/tournaments/${tournamentId}/board${r ? `?round=${r}` : ''}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа');
    }
  };
  useEffect(() => {
    void load(round);
  }, [tournamentId, round, refreshKey]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.bouts.filter((b) => {
      if (onlyMine && !(b.myShares && (b.myShares[0] > 0.5 || b.myShares[1] > 0.5)) && !(b.marketId && picks.has(b.marketId))) return false;
      if (!needle) return true;
      const hay = [b.a.name, b.a.fullName ?? '', b.a.titleLabel, b.a.place ?? '', b.b.name, b.b.fullName ?? '', b.b.titleLabel, b.b.place ?? ''].join(' ').toLowerCase();
      return needle.split(/\s+/).every((t) => hay.includes(t));
    });
  }, [data, q, onlyMine, picks]);

  // Миний бооцоо энэ даваанд: тавьсан / буцаж ирсэн / боломжит
  const mine = useMemo(() => {
    const out = { n: 0, cost: 0, returned: 0, potential: 0, resolved: 0, lost: 0 };
    for (const b of data?.bouts ?? []) {
      if (!b.myShares) continue;
      const [sa, sb] = b.myShares;
      if (sa < 0.5 && sb < 0.5) continue;
      out.n += 1;
      out.cost += b.myCost ?? 0;
      if (b.status === 'resolved' && b.winnerId) {
        out.resolved += 1;
        const w = b.winnerId === b.a.id ? sa : sb;
        out.returned += w;
        if (w < 0.5) out.lost += 1;
      } else if (b.status === 'voided') {
        out.resolved += 1;
        out.returned += b.myCost ?? 0;
      } else out.potential += Math.max(sa, sb);
    }
    return out;
  }, [data]);

  if (!data && !error) return <Loading />;
  if (!data) return <Msg text={error} />;

  const t = data.tournament;
  const st = data.status;
  const totalStake = [...picks.values()].reduce((a, p) => a + p.stake, 0);

  const toggle = (b: BoardBoutDto, which: 0 | 1) => {
    if (!b.marketId || b.status !== 'open') return;
    const id = b.marketId;
    setPicks((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      if (cur && cur.outcome === which) next.delete(id);
      else next.set(id, { outcome: which, stake: cur?.stake ?? lastStake });
      return next;
    });
  };
  const setStake = (marketId: string, stake: number) => {
    setLastStake(stake);
    setPicks((prev) => {
      const next = new Map(prev);
      const cur = next.get(marketId);
      if (cur) next.set(marketId, { ...cur, stake });
      return next;
    });
  };

  const place = async () => {
    if (!picks.size) return;
    if (!me.account.emailVerified) {
      setMsg({ kind: 'error', text: 'Имэйлээ баталгаажуулаагүй байна — «Би» хэсгээс кодоо оруулна уу.' });
      return;
    }
    if (totalStake > me.balance) {
      setMsg({ kind: 'error', text: `Үлдэгдэл хүрэлцэхгүй: ${fmtTokens(totalStake)} хэрэгтэй, ${fmtTokens(me.balance)} байна.` });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const orders: BatchBuyOrder[] = [...picks.entries()].map(([marketId, p]) => {
        let rid = requestIds.current.get(marketId);
        if (!rid) {
          rid = newRequestId();
          requestIds.current.set(marketId, rid);
        }
        return { marketId, outcome: p.outcome, spend: p.stake, requestId: rid };
      });
      const r = await api<BatchBuyResultDto>('/api/markets/buy-batch', { body: { orders } });
      onTraded(r.balance);
      const failed = r.results.filter((x) => !x.ok);
      setPicks((prev) => {
        const next = new Map(prev);
        for (const x of r.results) if (x.ok) next.delete(x.marketId);
        return next;
      });
      for (const x of r.results) if (x.ok) requestIds.current.delete(x.marketId);
      const okSum = orders.filter((o) => r.results.find((x) => x.marketId === o.marketId)?.ok).reduce((a, o) => a + o.spend, 0);
      const text = `${r.placed} бооцоо тавигдлаа (${fmtTokens(okSum)} токен).${failed.length ? ` Алдаа ${failed.length}: ${failed.map((f) => f.error).join('; ')}` : ''}`;
      setMsg({ kind: failed.length ? 'info' : 'ok', text });
      await load(round);
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Алдаа' });
    } finally {
      setBusy(false);
    }
  };

  const shownRound = data.round;
  const cur = st.current ? st.perRound[st.current - 1] : undefined;
  const headline = st.finished
    ? `Тэмцээн дууссан · аварга: ${st.championName ?? '?'}`
    : st.current
      ? `${st.current}-р даваа явж байна · ${cur?.total ?? 0} барилдаан, ${cur?.pending ?? 0} хүлээгдэж буй · ${st.alive} бөх үлдсэн`
      : `Эхлээгүй · ${st.entrants} бөх бүртгэлтэй — админ 1-р давааг эхлүүлэхэд хосууд энд гарна`;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={filtered}
        keyExtractor={(b) => b.id}
        contentContainerStyle={s.wrap}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            <Text style={s.back} onPress={onBack}>
              ← Буцах
            </Text>
            <Card style={{ gap: 6 }}>
              <Text style={s.title}>{t.name}</Text>
              <P muted small>
                {t.date} · {t.rounds} даваа · {t.entrants} бөх
              </P>
              <P small>{headline}</P>
              <Row gap={6}>
                {st.perRound.map((r) => {
                  const started = r.total > 0;
                  const active = r.round === shownRound;
                  return (
                    <Pressable
                      key={r.round}
                      disabled={!started}
                      onPress={() => setRound(r.round)}
                      style={[s.roundChip, active && s.roundChipOn, !started && { opacity: 0.35 }]}
                      accessibilityRole="button"
                    >
                      <Text style={[s.roundChipText, active && { color: theme.accentText }]}>
                        {r.round}
                        {started && r.pending === 0 ? ' ✓' : ''}
                      </Text>
                    </Pressable>
                  );
                })}
              </Row>
              <P muted small>
                {shownRound}-р даваа: {data.bouts.length} барилдаан. Бөх дээр дараад дүнгээ сонго → доор «Тавих». Хувь = зах зээлийн магадлал, × = коэффициент, «загвар» = Elo.
              </P>
            </Card>
            {mine.n ? (
              <View style={s.mineBox}>
                <Text style={s.mineTitle}>🧾 Миний бооцоо — {shownRound}-р даваа</Text>
                <Text style={s.mineText}>
                  {mine.n} барилдаан · тавьсан {fmtTokens(mine.cost)}
                  {mine.resolved ? ` · буцаж ирсэн +${fmtTokens(mine.returned)} (${mine.resolved - mine.lost} давсан, ${mine.lost} унасан) · ашиг ${mine.returned - mine.cost >= 0 ? '+' : ''}${fmtTokens(mine.returned - mine.cost)}` : ''}
                  {mine.potential ? ` · шийдэгдээгүй: давбал хүртэл ${fmtTokens(mine.potential)}` : ''}
                </Text>
                {mine.resolved && mine.resolved === mine.n ? <Text style={s.mineSub}>Төлбөр үлдэгдэлд орсон (дээд талын үлдэгдэл, «Би» → дэвтэр «Давалт»).</Text> : null}
                {!mine.resolved && mine.n ? <Text style={s.mineSub}>Админ давааг дуусгахад үр дүн гарч, давсан бөх дээрх бооцоо төлбөртэйгөө үлдэгдэлд буцаж орно.</Text> : null}
              </View>
            ) : null}
            <Row>
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Хайх: нэр, цол, аймаг… (жишээ: заан ховд)"
                placeholderTextColor={theme.muted}
                style={[s.search, { flex: 1 }]}
                autoCorrect={false}
              />
              <Pressable onPress={() => setOnlyMine((v) => !v)} style={[s.chip, onlyMine && s.chipOn]} accessibilityRole="button">
                <Text style={[s.chipText, onlyMine && { color: theme.accentText }]}>Миний</Text>
              </Pressable>
            </Row>
            <Msg text={msg?.text} kind={msg?.kind ?? 'info'} />
            {filtered.length === 0 ? (
              <Card>
                <P muted>{data.bouts.length === 0 ? 'Энэ даваанд барилдаан алга.' : 'Хайлтад таарах хос алга.'}</P>
              </Card>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <PairRow
            bout={item}
            index={index}
            pick={item.marketId ? picks.get(item.marketId) : undefined}
            onToggle={(which) => toggle(item, which)}
            onStake={(stake) => item.marketId && setStake(item.marketId, stake)}
            onOpenMarket={onOpenMarket}
          />
        )}
        ListFooterComponent={<View style={{ height: picks.size ? 90 : 20 }} />}
      />
      {picks.size ? (
        <View style={s.bar}>
          <View style={{ flexShrink: 1 }}>
            <Text style={s.barText}>
              {picks.size} бооцоо · {fmtTokens(totalStake)} токен
            </Text>
            <Text style={s.barSub}>үлдэгдэл {fmtTokens(me.balance)}</Text>
          </View>
          <Row>
            <Button small title="Цэвэрлэх" variant="secondary" onPress={() => setPicks(new Map())} disabled={busy} />
            <Button small title={`Тавих (${picks.size})`} variant="accent" onPress={() => void place()} loading={busy} />
          </Row>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 12, gap: 10 },
  back: { color: theme.accent, fontWeight: '700' },
  title: { color: theme.text, fontSize: 17, fontWeight: '800' },
  roundChip: { minWidth: 34, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.raised, alignItems: 'center' },
  roundChipOn: { backgroundColor: theme.accent },
  roundChipText: { color: theme.text, fontWeight: '800', fontSize: 13 },
  search: { backgroundColor: theme.raised, color: theme.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, borderWidth: 1, borderColor: theme.border },
  pair: { backgroundColor: theme.surface, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border, padding: 10, gap: 8, marginBottom: 10 },
  pairNo: { color: theme.muted, fontSize: 12, fontWeight: '700' },
  vol: { color: theme.muted, fontSize: 12 },
  sides: { flexDirection: 'row', alignItems: 'stretch', gap: 6 },
  vs: { color: theme.muted, alignSelf: 'center', fontWeight: '800' },
  side: { flex: 1, backgroundColor: theme.raised, borderRadius: 10, padding: 10, gap: 3, borderWidth: 2, borderColor: 'transparent' },
  sideRight: { alignItems: 'flex-end' },
  sideSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
  sideWon: { backgroundColor: theme.success, borderColor: theme.success },
  name: { color: theme.text, fontSize: 15, fontWeight: '800' },
  sub: { color: theme.muted, fontSize: 12 },
  pct: { color: theme.text, fontSize: 16, fontWeight: '800' },
  odds: { color: theme.accent, fontSize: 13, fontWeight: '800' },
  model: { color: theme.muted, fontSize: 11 },
  wonTag: { color: '#052e16', fontWeight: '800', fontSize: 12 },
  mine: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  selTag: { color: theme.accentText, fontSize: 12, fontWeight: '800' },
  stakeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  stakeLabel: { color: theme.muted, fontSize: 13 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.raised, borderWidth: 1, borderColor: theme.border },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.text, fontWeight: '700', fontSize: 13 },
  customInput: { width: 76, backgroundColor: theme.raised, color: theme.text, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, borderWidth: 1, borderColor: theme.border },
  est: { color: theme.muted, fontSize: 13 },
  more: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  mineBox: { backgroundColor: theme.surface, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.accent, padding: 10, gap: 4 },
  mineTitle: { color: theme.accent, fontWeight: '800', fontSize: 14 },
  mineText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  mineSub: { color: theme.muted, fontSize: 12 },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: 12, backgroundColor: theme.surface, borderTopWidth: 2, borderTopColor: theme.accent },
  barText: { color: theme.text, fontWeight: '800', fontSize: 15 },
  barSub: { color: theme.muted, fontSize: 12 },
});
