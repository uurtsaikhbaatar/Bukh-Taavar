import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, newRequestId } from '../api';
import { Button, Card, Field, H2, KV, Msg, P, Row } from '../components/ui';
import { fmtPct, fmtTokens } from '../format';
import type { CouponDto, CouponQuoteDto, CouponRequest, MeDto } from '../shared/api';
import { theme } from '../theme';

/** Купонд нэмсэн сонголт (клиент талын төлөв). */
export interface SlipItem {
  marketId: string;
  outcome: number;
  marketTitle: string;
  outcomeLabel: string;
  price: number;
}

const QUICK = [50, 100, 300, 500, 1000];

type Mode = 'express' | 'system' | 'lucky' | 'patent';

function sizesFor(mode: Mode, n: number, k: number): number[] {
  if (mode === 'express') return [n];
  if (mode === 'lucky') return Array.from({ length: n }, (_, i) => i + 1);
  if (mode === 'patent') return Array.from({ length: n - 1 }, (_, i) => i + 2);
  return [k];
}

export function CouponScreen({
  slip,
  me,
  onRemove,
  onClear,
  onBack,
  onPlaced,
}: {
  slip: SlipItem[];
  me: MeDto;
  onRemove: (marketId: string) => void;
  onClear: () => void;
  onBack: () => void;
  onPlaced: (balance: number) => void;
}) {
  const n = slip.length;
  const [mode, setMode] = useState<Mode>('express');
  const [k, setK] = useState(2);
  const [stake, setStake] = useState('100');
  const [quote, setQuote] = useState<CouponQuoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CouponDto | null>(null);
  const requestId = useRef(newRequestId());

  const request = (): CouponRequest | null => {
    const s = Number(stake);
    if (n < 2 || !Number.isInteger(s) || s < 10) return null;
    const kind = mode === 'express' ? 'express' : 'system';
    const req: CouponRequest = { legs: slip.map((l) => ({ marketId: l.marketId, outcome: l.outcome })), stake: s, kind };
    if (kind === 'system') req.sizes = sizesFor(mode, n, k);
    return req;
  };

  useEffect(() => {
    const req = request();
    if (!req) {
      setQuote(null);
      return;
    }
    let alive = true;
    api<CouponQuoteDto>('/api/coupons/quote', { body: req })
      .then((q) => {
        if (!alive) return;
        setQuote(q);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setQuote(null);
        setError(e instanceof ApiError ? e.message : 'Алдаа');
      });
    return () => {
      alive = false;
    };
  }, [slip.map((l) => `${l.marketId}:${l.outcome}`).join('|'), mode, k, stake]);

  const place = async () => {
    const req = request();
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ coupon: CouponDto; balance: number }>('/api/coupons', { body: { ...req, requestId: requestId.current } });
      requestId.current = newRequestId();
      setDone(r.coupon);
      onPlaced(r.balance);
      onClear();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <ScrollView contentContainerStyle={s.wrap}>
        <Text style={s.back} onPress={onBack}>
          ← Буцах
        </Text>
        <Card style={{ gap: 8 }}>
          <H2>Купон тавигдлаа ✔</H2>
          <P>
            {done.kind === 'express' ? 'Экспресс' : 'Систем'} · {done.legs.length} сонголт · {fmtTokens(done.stake)} токен · давбал {fmtTokens(done.maxPayout)} хүртэл
          </P>
          {done.legs.map((l, i) => (
            <P key={i} small muted>
              {l.marketTitle} → {l.outcomeLabel} ({fmtPct(l.price)})
            </P>
          ))}
          <P muted small>Явц ба үр дүнг «Би» хэсгийн «Купонууд»-аас харна.</P>
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.back} onPress={onBack}>
        ← Буцах
      </Text>
      <Card style={{ gap: 8 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>Купон ({n})</H2>
          {n ? <Button small variant="ghost" title="Цэвэрлэх" onPress={onClear} /> : null}
        </Row>
        {n === 0 ? <P muted>Зах зээлийн хуудаснаас «＋ купон» дарж сонголт нэмнэ. Дор хаяж 2 өөр зах зээл.</P> : null}
        {slip.map((l) => (
          <Row key={l.marketId} style={{ justifyContent: 'space-between' }}>
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: theme.text, fontSize: 13 }} numberOfLines={2}>
                {l.marketTitle}
              </Text>
              <Text style={{ color: theme.accent, fontWeight: '700' }}>
                {l.outcomeLabel} · {fmtPct(l.price)} · ×{(1 / l.price).toFixed(2)}
              </Text>
            </View>
            <Button small variant="ghost" title="✕" onPress={() => onRemove(l.marketId)} />
          </Row>
        ))}
      </Card>

      {n >= 2 ? (
        <Card style={{ gap: 10 }}>
          <Row>
            <Button small title="Экспресс" variant={mode === 'express' ? 'accent' : 'secondary'} onPress={() => setMode('express')} />
            {n >= 3 ? <Button small title="Систем" variant={mode === 'system' ? 'accent' : 'secondary'} onPress={() => setMode('system')} /> : null}
            <Button small title="Lucky" variant={mode === 'lucky' ? 'accent' : 'secondary'} onPress={() => setMode('lucky')} />
            {n >= 3 ? <Button small title="Patent" variant={mode === 'patent' ? 'accent' : 'secondary'} onPress={() => setMode('patent')} /> : null}
          </Row>
          {mode === 'system' ? (
            <Row>
              <P small muted>Хослолын хэмжээ:</P>
              {Array.from({ length: n - 2 }, (_, i) => i + 2).map((kk) => (
                <Button key={kk} small title={`${kk}/${n}`} variant={k === kk ? 'accent' : 'secondary'} onPress={() => setK(kk)} />
              ))}
            </Row>
          ) : null}
          <P muted small>
            {mode === 'express'
              ? 'Экспресс: бүх сонголт давбал коэффициентүүд үржигдэж төлөгдөнө; нэг нь унавал бүгд алдана.'
              : mode === 'lucky'
                ? 'Lucky: бүх дан, давхар, … хослолд тэнцүү хуваана — 1 нь давсан ч төлбөр гарна.'
                : mode === 'patent'
                  ? 'Patent: 2 ба түүнээс дээш сонголттой бүх хослол — дор хаяж 2 таарах ёстой.'
                  : `Систем ${k}/${n}: ${k} сонголттой бүх хослолд тэнцүү хуваана.`}
          </P>
          <Row>
            {QUICK.map((q) => (
              <Button key={q} small title={fmtTokens(q)} variant={stake === String(q) ? 'accent' : 'secondary'} onPress={() => setStake(String(q))} />
            ))}
          </Row>
          <Field label={`Бооцоо (үлдэгдэл ${fmtTokens(me.balance)}, дээд 5 000)`} value={stake} onChangeText={setStake} keyboard="numeric" />
          {quote ? (
            <Row style={{ justifyContent: 'space-between' }}>
              <KV k="Хослол" v={`${quote.combos} × ${fmtTokens(Math.floor(quote.unitStake))}`} />
              {quote.kind === 'express' ? <KV k="Коэффициент" v={`×${quote.coefficient.toFixed(2)}${quote.capped ? ' (тааз)' : ''}`} /> : null}
              <KV k="Давбал (дээд)" v={fmtTokens(quote.maxPayout)} vColor={theme.success} />
            </Row>
          ) : null}
          <Msg text={error} />
          {!me.account.emailVerified ? <Msg kind="info" text="Купон тавихын өмнө имэйлээ баталгаажуулна уу." /> : null}
          <Button title={quote ? `${fmtTokens(quote.stake)} токен тавих` : 'Тоо оруул'} variant="accent" onPress={place} disabled={!quote || !me.account.emailVerified} loading={busy} />
        </Card>
      ) : null}
    </ScrollView>
  );
}

export function CouponList({ coupons }: { coupons: CouponDto[] }) {
  if (!coupons.length) return <P muted>Купон алга.</P>;
  return (
    <>
      {coupons.map((c) => (
        <View key={c.id} style={s.coupon}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: theme.text, fontWeight: '700' }}>
              {c.kind === 'express' ? 'Экспресс' : 'Систем'} · {c.legs.length} сонголт · {fmtTokens(c.stake)}
            </Text>
            <Text style={{ color: c.status === 'won' ? theme.success : c.status === 'lost' ? theme.danger : c.status === 'void' ? theme.muted : theme.warn, fontWeight: '800' }}>
              {c.status === 'open' ? `хүлээгдэж… (дээд ${fmtTokens(c.maxPayout)})` : c.status === 'won' ? `+${fmtTokens(c.payout ?? 0)}` : c.status === 'lost' ? 'алдав' : `хүчингүй +${fmtTokens(c.payout ?? 0)}`}
            </Text>
          </Row>
          {c.legs.map((l, i) => (
            <P key={i} small muted>
              {l.result === 'won' ? '✔' : l.result === 'lost' ? '✖' : l.result === 'void' ? '○' : '…'} {l.outcomeLabel} ({fmtPct(l.price)}) — {l.marketTitle.slice(0, 60)}
            </P>
          ))}
        </View>
      ))}
    </>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 14, paddingBottom: 40 },
  back: { color: theme.accent, fontSize: 15, fontWeight: '700' },
  coupon: { gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border },
});
