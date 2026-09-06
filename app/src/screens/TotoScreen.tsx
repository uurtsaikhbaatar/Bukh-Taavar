import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, newRequestId } from '../api';
import { Button, Card, H2, KV, Loading, Msg, P, Pill, Row } from '../components/ui';
import { fmtPct, fmtTokens, fmtWhen } from '../format';
import type { MeDto, TotoDto } from '../shared/api';
import { theme } from '../theme';

export function TotoScreen({ me, refreshKey, onTraded }: { me: MeDto; refreshKey: number; onTraded: (balance: number) => void }) {
  const [totos, setTotos] = useState<TotoDto[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ totos: TotoDto[] }>('/api/totos')
      .then((d) => {
        setTotos(d.totos);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
  }, [refreshKey]);

  if (!totos) return error ? <Msg text={error} /> : <Loading />;
  const open = totos.find((t) => t.id === openId);
  if (open) return <TotoDetail toto={open} me={me} onBack={() => setOpenId(null)} onTraded={onTraded} refreshKey={refreshKey} />;

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card>
        <H2>Багц таавар (пул)</H2>
        <P muted small>
          N барилдааны давагчийг таана. Оролцооны хураамж бүгд нэг пулд цугларч, хамгийн олон зөв таасан нар шатлан хуваана (60% / 30% / 10%). Хэн ч таагаагүй бол бүгдэд буцаана.
        </P>
      </Card>
      {totos.length === 0 ? (
        <Card>
          <P muted>Одоогоор багц таавар алга. Админ тэмцээний барилдаануудаас үүсгэнэ.</P>
        </Card>
      ) : null}
      {totos.map((t) => (
        <Card key={t.id} onPress={() => setOpenId(t.id)}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={s.title}>{t.title}</Text>
            <Pill
              text={t.status === 'open' ? (t.canEnter ? 'Нээлттэй' : t.myPicks ? 'Орсон' : 'Хаагдсан') : t.status === 'settled' ? 'Дууссан' : 'Хүчингүй'}
              color={t.status === 'open' ? (t.canEnter ? theme.success : theme.warn) : theme.raised}
              textColor={t.status === 'open' ? '#052e16' : theme.text}
            />
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <P muted small>
              {t.bouts.length} барилдаан · хураамж {fmtTokens(t.fee)} · пул {fmtTokens(t.pool)} · {t.entries.length} оролцогч
            </P>
            {t.myPicks ? <P small>Миний таамаг өгсөн ✔</P> : null}
          </Row>
        </Card>
      ))}
    </ScrollView>
  );
}

function TotoDetail({ toto, me, onBack, onTraded, refreshKey }: { toto: TotoDto; me: MeDto; onBack: () => void; onTraded: (b: number) => void; refreshKey: number }) {
  const [data, setData] = useState<TotoDto>(toto);
  const [picks, setPicks] = useState<(string | null)[]>(toto.myPicks ?? toto.bouts.map(() => null));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const requestId = useRef(newRequestId());

  useEffect(() => {
    api<TotoDto>(`/api/totos/${toto.id}`)
      .then((d) => {
        setData(d);
        if (d.myPicks) setPicks(d.myPicks);
      })
      .catch(() => undefined);
  }, [toto.id, refreshKey]);

  const enter = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ toto: TotoDto; balance: number }>(`/api/totos/${data.id}/enter`, { body: { picks, requestId: requestId.current } });
      requestId.current = newRequestId();
      setData(r.toto);
      onTraded(r.balance);
      setMsg({ kind: 'ok', text: 'Таамаг бүртгэгдлээ! Барилдаанууд дуусахад автоматаар тооцно.' });
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Алдаа' });
    } finally {
      setBusy(false);
    }
  };

  const filled = picks.filter(Boolean).length;
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.back} onPress={onBack}>
        ← Багц таавар
      </Text>
      <Card style={{ gap: 6 }}>
        <H2>{data.title}</H2>
        <Row style={{ justifyContent: 'space-between' }}>
          <KV k="Хураамж" v={fmtTokens(data.fee)} />
          <KV k="Пул" v={fmtTokens(data.pool)} vColor={theme.accent} />
          <KV k="Оролцогч" v={String(data.entries.length)} />
          <KV k="Хуваарилалт" v={data.tiers.map((x) => `${Math.round(x * 100)}%`).join(' / ')} />
        </Row>
        {data.closesAt ? <P muted small>Хаагдах: {fmtWhen(data.closesAt)}</P> : null}
      </Card>

      <Card style={{ gap: 10 }}>
        <H2>{data.canEnter ? `Таамаг (${filled}/${data.bouts.length})` : 'Барилдаанууд'}</H2>
        {data.bouts.map((b, i) => {
          const chosen = picks[i];
          const my = data.myPicks?.[i];
          return (
            <View key={b.boutId} style={s.bout}>
              <P muted small>
                {b.round}-р даваа{b.priorA !== undefined ? ` · загвар ${fmtPct(b.priorA)} / ${fmtPct(1 - b.priorA)}` : ''}
                {b.winnerId ? ` · ${b.winnerId === b.a.id ? b.a.name : b.b.name} давсан` : ''}
              </P>
              <Row>
                {[b.a, b.b].map((w) => {
                  const active = data.canEnter ? chosen === w.id : my === w.id;
                  const correct = b.winnerId ? b.winnerId === w.id : undefined;
                  return (
                    <Button
                      key={w.id}
                      small
                      variant={active ? (correct === undefined ? 'accent' : correct ? 'accent' : 'danger') : 'secondary'}
                      title={`${w.name} (${w.titleLabel}${w.place ? `, ${w.place}` : ''})`}
                      disabled={!data.canEnter}
                      onPress={() => setPicks((p) => p.map((x, j) => (j === i ? (x === w.id ? null : w.id) : x)))}
                    />
                  );
                })}
              </Row>
            </View>
          );
        })}
        {msg ? <Msg text={msg.text} kind={msg.kind} /> : null}
        {data.canEnter ? (
          <Button
            title={`${fmtTokens(data.fee)} токеноор оролцох`}
            variant="accent"
            loading={busy}
            disabled={filled === 0 || !me.account.emailVerified}
            onPress={enter}
          />
        ) : data.myPicks ? (
          <P muted small>Та оролцсон. {data.status !== 'open' ? 'Үр дүн доор.' : 'Барилдаанууд дуусахыг хүлээж байна.'}</P>
        ) : (
          <P muted small>Энэ багц таавар хаагдсан.</P>
        )}
      </Card>

      {data.entries.length ? (
        <Card>
          <H2>Оролцогчид</H2>
          {data.entries.map((e) => (
            <Row key={e.userId} style={[{ justifyContent: 'space-between', paddingVertical: 3 }, e.me && s.meRow]}>
              <P small style={e.me ? { color: theme.accent } : undefined}>
                {e.userName}
                {e.correct !== undefined ? ` · ${e.correct}/${data.bouts.length} зөв` : ''}
              </P>
              {e.payout !== undefined ? <Text style={{ color: e.payout > 0 ? theme.success : theme.muted, fontWeight: '700' }}>{e.payout > 0 ? `+${fmtTokens(e.payout)}` : '—'}</Text> : null}
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
  bout: { gap: 4, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.border },
  meRow: { backgroundColor: theme.raised, borderRadius: 8, paddingHorizontal: 6 },
});
