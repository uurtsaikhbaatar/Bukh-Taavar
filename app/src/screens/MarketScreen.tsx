import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, newRequestId } from '../api';
import { Button, Card, Field, H2, KV, Loading, Msg, P, ProbBar, Row } from '../components/ui';
import { fmtPct, fmtShares, fmtSigned, fmtTokens, fmtWhen } from '../format';
import type { H2hDto, MarketDetailDto, MeDto, QuoteDto, SellQuoteDto, TradeResultDto } from '../shared/api';
import { theme } from '../theme';
import type { SlipItem } from './CouponScreen';
import { statusPill } from './HomeScreen';

const QUICK = [100, 300, 500, 1000, 3000];

export function MarketScreen({
  marketId,
  me,
  refreshKey,
  slip,
  onAddToSlip,
  onBack,
  onTraded,
}: {
  marketId: string;
  me: MeDto;
  refreshKey: number;
  slip: SlipItem[];
  onAddToSlip: (item: SlipItem) => void;
  onBack: () => void;
  onTraded: (balance: number) => void;
}) {
  const [data, setData] = useState<MarketDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState(0);
  const [spend, setSpend] = useState('300');
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [sellShares, setSellShares] = useState('');
  const [sellQuote, setSellQuote] = useState<SellQuoteDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [h2h, setH2h] = useState<H2hDto | null | 'none'>(null);
  const requestId = useRef(newRequestId());

  const load = async () => {
    try {
      setData(await api<MarketDetailDto>(`/api/markets/${marketId}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа');
    }
  };
  useEffect(() => {
    void load();
  }, [marketId, refreshKey]);

  const m = data?.market;
  const tradable = m?.status === 'open';

  // Хоорондын харьцаа (архив байвал) — барилдааны зах зээлд
  const boutA = data?.bout?.a.id;
  const boutB = data?.bout?.b.id;
  useEffect(() => {
    if (!boutA || !boutB) return;
    let alive = true;
    api<H2hDto>(`/api/h2h?a=${encodeURIComponent(boutA)}&b=${encodeURIComponent(boutB)}`)
      .then((r) => alive && setH2h(r))
      .catch(() => alive && setH2h('none'));
    return () => {
      alive = false;
    };
  }, [boutA, boutB]);

  // Санал (quote) — тоо өөрчлөгдөх бүрд
  useEffect(() => {
    if (!m || !tradable) return;
    const n = Number(spend);
    if (!Number.isInteger(n) || n < 10) {
      setQuote(null);
      return;
    }
    let alive = true;
    api<QuoteDto>(`/api/markets/${m.id}/quote`, { body: { outcome, spend: n } })
      .then((q) => alive && setQuote(q))
      .catch(() => alive && setQuote(null));
    return () => {
      alive = false;
    };
  }, [m?.id, m?.probs.join(','), outcome, spend, tradable]);

  const myShares = m?.myPosition?.[outcome] ?? 0;
  useEffect(() => {
    if (!m || !tradable) return;
    const n = Number(sellShares);
    if (!(n > 0) || n > myShares + 1e-9) {
      setSellQuote(null);
      return;
    }
    let alive = true;
    api<SellQuoteDto>(`/api/markets/${m.id}/quote-sell`, { body: { outcome, shares: n } })
      .then((q) => alive && setSellQuote(q))
      .catch(() => alive && setSellQuote(null));
    return () => {
      alive = false;
    };
  }, [m?.id, m?.probs.join(','), outcome, sellShares, tradable, myShares]);

  const buy = async () => {
    if (!m || !quote) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<TradeResultDto>(`/api/markets/${m.id}/buy`, { body: { outcome, spend: quote.spend, requestId: requestId.current } });
      requestId.current = newRequestId();
      setData((d) => (d ? { ...d, market: r.market } : d));
      onTraded(r.balance);
      setMsg({ kind: 'ok', text: `${fmtTokens(quote.spend)} токеноор «${m.outcomes[outcome]}» ${fmtShares(r.trade.shares)} хувь авлаа. Давбал ${fmtTokens(Math.round(r.trade.shares))}.` });
      void load();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Алдаа' });
    } finally {
      setBusy(false);
    }
  };

  const sell = async () => {
    if (!m || !sellQuote) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<TradeResultDto>(`/api/markets/${m.id}/sell`, { body: { outcome, shares: sellQuote.shares, requestId: requestId.current } });
      requestId.current = newRequestId();
      setData((d) => (d ? { ...d, market: r.market } : d));
      onTraded(r.balance);
      setSellShares('');
      setMsg({ kind: 'ok', text: `${fmtShares(sellQuote.shares)} хувь зарж ${fmtTokens(r.trade.delta)} токен авлаа.` });
      void load();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Алдаа' });
    } finally {
      setBusy(false);
    }
  };

  if (!m) return error ? <Msg text={error} /> : <Loading />;
  const bout = data?.bout;

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.back} onPress={onBack}>
        ← Буцах
      </Text>
      <Card style={{ gap: 10 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={s.title}>{m.title}</Text>
          {statusPill(m)}
        </Row>
        {bout ? (
          <Row style={{ justifyContent: 'space-around', alignItems: 'flex-start' }}>
            {[bout.a, bout.b].map((w) => (
              <View key={w.id} style={{ alignItems: 'center', gap: 2, flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16, textAlign: 'center' }}>{w.fullName ?? w.name}</Text>
                <Text style={{ color: theme.accent, fontSize: 13, textAlign: 'center', fontWeight: '700' }}>{w.titleLabel}</Text>
                <Text style={{ color: theme.muted, fontSize: 12, textAlign: 'center' }}>
                  {w.place ?? '—'}
                  {w.birthDate ? ` · ${w.birthDate.slice(0, 4)} он` : ''}
                </Text>
                {w.height || w.weight || w.club ? (
                  <Text style={{ color: theme.muted, fontSize: 12, textAlign: 'center' }}>
                    {[w.height ? `${w.height} см` : null, w.weight ? `${w.weight} кг` : null, w.club ? `«${w.club}» дэвжээ` : null].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                <Text style={{ color: theme.muted, fontSize: 12 }}>Elo {w.rating}</Text>
              </View>
            ))}
          </Row>
        ) : null}
        {bout && (bout.a.titles?.length || bout.b.titles?.length) ? (
          <View style={{ gap: 2 }}>
            {[bout.a, bout.b].map((w) =>
              w.titles?.length ? (
                <P key={w.id} muted small>
                  {w.name} — цол: {w.titles.map((t) => `${t.titleLabel} ${t.date.slice(0, 4)}${t.rounds ? ` (${t.rounds})` : ''}`).join(' → ')}
                </P>
              ) : null,
            )}
          </View>
        ) : null}
        {m.outcomes.map((o, i) => (
          <ProbBar
            key={i}
            label={o}
            sub={m.wrestlers && i < 2 ? `${(i === 0 ? m.wrestlers.a : m.wrestlers.b).titleLabel}${(i === 0 ? m.wrestlers.a : m.wrestlers.b).place ? ` · ${(i === 0 ? m.wrestlers.a : m.wrestlers.b).place}` : ''}` : undefined}
            prob={m.probs[i]}
            model={m.modelProbs?.[i]}
            highlight={tradable ? outcome === i : m.resolvedOutcome === i}
            onPress={tradable ? () => setOutcome(i) : undefined}
            right={m.probs[i] !== undefined ? `×${(1 / Math.max(1e-6, m.probs[i]!)).toFixed(2)}${m.modelProbs ? ` · загвар ${fmtPct(m.modelProbs[i] ?? 0)}` : ''}` : 'бооцоо ороогүй'}
          />
        ))}
        <P muted small>
          Тод зурвас = зах зээлийн магадлал (таавраар хөдөлнө), цагаан тэмдэг = загварын (Elo) магадлал. Эргэлт {fmtTokens(m.volume)} токен · {m.traders} хүн · {m.tradeCount} арилжаа
          {m.closesAt ? ` · хаагдана ${fmtWhen(m.closesAt)}` : ''}
        </P>
        {tradable ? (
          <Row>
            <P small muted>Купонд нэмэх (экспресс/систем):</P>
            {m.outcomes.map((o, i) => {
              const inSlip = slip.some((x) => x.marketId === m.id && x.outcome === i);
              return (
                <Button
                  key={i}
                  small
                  variant={inSlip ? 'accent' : 'secondary'}
                  title={`${inSlip ? '✓' : '＋'} ${o}${m.probs[i] !== undefined ? ` ×${(1 / Math.max(1e-6, m.probs[i]!)).toFixed(2)}` : ''}`}
                  onPress={() => onAddToSlip({ marketId: m.id, outcome: i, marketTitle: m.title, outcomeLabel: o, price: m.probs[i] ?? 0.5 })}
                />
              );
            })}
          </Row>
        ) : null}
      </Card>

      {h2h && h2h !== 'none' ? (
        <Card style={{ gap: 6 }}>
          <H2>Хоорондын харьцаа (devjee архив)</H2>
          <Row style={{ justifyContent: 'space-between' }}>
            <KV k={h2h.a.name} v={`${h2h.direct.aWins} давалт`} vColor={h2h.direct.aWins >= h2h.direct.bWins ? theme.success : theme.text} />
            <KV k="Хоорондоо" v={`${h2h.direct.bouts.length} удаа`} />
            <KV k={h2h.b.name} v={`${h2h.direct.bWins} давалт`} vColor={h2h.direct.bWins > h2h.direct.aWins ? theme.success : theme.text} />
          </Row>
          {h2h.direct.bouts.slice(0, 5).map((x, i) => (
            <P key={i} muted small>
              {x.date} · {x.round}-р даваа · {x.winnerId === h2h.a.id ? h2h.a.name : h2h.b.name} давсан · {x.tournament.slice(0, 50)}
            </P>
          ))}
          <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
            {h2h.chain.pA !== undefined ? <KV k={`Гинж ${h2h.chain.maxHops} үе (туршилтын)`} v={h2h.chain.connected ? fmtPct(h2h.chain.pA) : '—'} /> : null}
            {h2h.bt ? <KV k="Bradley–Terry" v={fmtPct(h2h.bt.pA)} /> : null}
            {h2h.elo ? <KV k="Elo рейтинг" v={h2h.elo.pA !== undefined ? fmtPct(h2h.elo.pA) : `${h2h.elo.ratingA} — ${h2h.elo.ratingB}`} /> : null}
            <KV k="Нийт амжилт" v={`${h2h.a.wins}–${h2h.a.losses} / ${h2h.b.wins}–${h2h.b.losses}`} />
          </Row>
          {h2h.chain.pathsAB[0] ? (
            <P muted small>
              {h2h.a.name} давамгайлах гинж: {h2h.chain.pathsAB[0].names.join(' → ')} ({h2h.chain.pathsAB[0].dates.map((d) => d.slice(0, 4)).join(', ')})
            </P>
          ) : null}
          {h2h.chain.pathsBA[0] ? (
            <P muted small>
              {h2h.b.name} давамгайлах гинж: {h2h.chain.pathsBA[0].names.join(' → ')} ({h2h.chain.pathsBA[0].dates.map((d) => d.slice(0, 4)).join(', ')})
            </P>
          ) : null}
        </Card>
      ) : null}

      {m.myPosition ? (
        <Card>
          <H2>Миний эзэмшил</H2>
          {m.outcomes.map((o, i) =>
            (m.myPosition?.[i] ?? 0) > 0.5 ? (
              <Row key={i} style={{ justifyContent: 'space-between' }}>
                <P>{o}</P>
                <P>
                  {fmtShares(m.myPosition![i]!)} хувь{m.status === 'resolved' ? (m.resolvedOutcome === i ? ` → ${fmtTokens(Math.round(m.myPosition![i]!))} авсан` : ' → 0') : ` ≈ ${fmtTokens((m.myPosition![i] ?? 0) * (m.probs[i] ?? 0))}`}
                </P>
              </Row>
            ) : null,
          )}
          <P muted small>Цэвэр зарцуулалт {fmtTokens(m.myNetCost ?? 0)}</P>
        </Card>
      ) : null}

      {tradable ? (
        <Card style={{ gap: 12 }}>
          <H2>Таавар тавих — «{m.outcomes[outcome]}»</H2>
          {!me.account.emailVerified ? <Msg kind="info" text="Таавар тавихын өмнө имэйлээ баталгаажуулна уу («Би» хэсэг)." /> : null}
          <Row>
            {QUICK.map((q) => (
              <Button key={q} title={fmtTokens(q)} small variant={spend === String(q) ? 'accent' : 'secondary'} onPress={() => setSpend(String(q))} />
            ))}
          </Row>
          <Field label={`Токен (үлдэгдэл ${fmtTokens(me.balance)})`} value={spend} onChangeText={setSpend} keyboard="numeric" />
          {quote ? (
            <Row style={{ justifyContent: 'space-between' }}>
              <KV k="Хувь" v={fmtShares(quote.shares)} />
              <KV k="Давбал" v={fmtTokens(quote.payoutIfWin)} vColor={theme.success} />
              <KV k="Үржүүлэгч" v={`×${quote.multiplier.toFixed(2)}`} />
              <KV k="Магадлал" v={`${fmtPct(quote.priceBefore)} → ${fmtPct(quote.priceAfter)}`} />
            </Row>
          ) : (
            <P muted small>Хамгийн бага бооцоо 10 токен.</P>
          )}
          <Button title={quote ? `${fmtTokens(quote.spend)} токен тавих` : 'Тоо оруул'} onPress={buy} disabled={!quote || !me.account.emailVerified} loading={busy} variant="accent" />

          {myShares > 0.5 ? (
            <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 10 }}>
              <H2>Кэш-аут (зарах) — «{m.outcomes[outcome]}» ({fmtShares(myShares)} хувь байна)</H2>
              <Row>
                <Button title="Хагас" small variant="secondary" onPress={() => setSellShares((myShares / 2).toFixed(2))} />
                <Button title="Бүгд" small variant="secondary" onPress={() => setSellShares(myShares.toFixed(2))} />
              </Row>
              <Field label="Зарах хувь" value={sellShares} onChangeText={setSellShares} keyboard="numeric" />
              {sellQuote ? <P>Орлого ≈ {fmtTokens(sellQuote.proceeds)} токен · магадлал {fmtPct(sellQuote.priceBefore)} → {fmtPct(sellQuote.priceAfter)}</P> : null}
              <Button title="Кэш-аут" onPress={sell} disabled={!sellQuote} loading={busy} variant="secondary" />
            </View>
          ) : null}
          {msg ? <Msg text={msg.text} kind={msg.kind} /> : null}
        </Card>
      ) : msg ? (
        <Msg text={msg.text} kind={msg.kind} />
      ) : null}

      {data?.recentTrades.length ? (
        <Card>
          <H2>Сүүлийн арилжаа</H2>
          {data.recentTrades.map((t) => (
            <Row key={t.id} style={{ justifyContent: 'space-between' }}>
              <P small>
                {fmtWhen(t.at)} · {t.userName ?? '?'}
              </P>
              <P small>
                {t.shares > 0 ? 'авав' : 'зарав'} «{m.outcomes[t.outcome]}» {fmtShares(Math.abs(t.shares))} ({fmtSigned(t.delta)})
              </P>
            </Row>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 14, paddingBottom: 40 },
  back: { color: theme.accent, fontSize: 15, fontWeight: '700' },
  title: { color: theme.text, fontSize: 16, fontWeight: '800', flexShrink: 1 },
});
