import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, saveToken } from '../api';
import { Button, Card, Field, H2, KV, Loading, Msg, P, Row } from '../components/ui';
import { fmtShares, fmtSigned, fmtTokens, fmtWhen } from '../format';
import type { LeaderboardRowDto, MeDto, PortfolioDto } from '../shared/api';
import { theme } from '../theme';
import { CouponList } from './CouponScreen';

const KIND_LABEL: Record<string, string> = { start: 'Эхлэл', grant: 'Олголт', buy: 'Авсан', sell: 'Кэш-аут (зарсан)', payout: 'Давалт', refund: 'Буцаалт', coupon: 'Купон', coupon_win: 'Купон давалт', coupon_refund: 'Купон буцаалт' };

export function PortfolioScreen({
  me,
  refreshKey,
  onOpenMarket,
  onMe,
  onLogout,
}: {
  me: MeDto;
  refreshKey: number;
  onOpenMarket: (id: string) => void;
  onMe: (me: MeDto) => void;
  onLogout: () => void;
}) {
  const [data, setData] = useState<PortfolioDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    api<PortfolioDto>('/api/portfolio')
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
  }, [refreshKey]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ kind: 'ok', text: await fn() });
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Алдаа' });
    } finally {
      setBusy(false);
    }
  };

  const open = data?.positions.filter((p) => p.status === 'open' || p.status === 'closed') ?? [];
  const openValue = open.reduce((a, p) => a + p.value, 0);

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card style={{ gap: 10 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <Text style={s.name}>{me.account.username}</Text>
            <P muted small>
              {me.account.email} · {me.account.role === 'admin' ? 'админ' : 'гишүүн'}
            </P>
          </View>
          <Button title="Гарах" small variant="secondary" onPress={async () => {
            try {
              await api('/api/logout', { body: {} });
            } catch {
              // хамаагүй
            }
            await saveToken(null);
            onLogout();
          }} />
        </Row>
        {me.balance < 5000 ? (
          <Button
            title="Өдрийн урамшуулал авах (+200)"
            variant="accent"
            small
            loading={busy}
            onPress={() =>
              run(async () => {
                const r = await api<{ amount: number; me: MeDto }>('/api/bonus', { body: {} });
                if (r.amount > 0) {
                  onMe({ ...me, balance: me.balance + r.amount });
                  return `+${r.amount} токен нэмэгдлээ.`;
                }
                return 'Өнөөдөр аль хэдийн авсан байна (20 цагт нэг удаа).';
              })
            }
          />
        ) : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <KV k="Үлдэгдэл" v={fmtTokens(me.balance)} vColor={theme.accent} />
          <KV k="Нээлттэй эзэмшил" v={fmtTokens(openValue)} />
          <KV k="Нийт" v={fmtTokens(me.balance + openValue)} />
          <KV k="Ашиг/алдагдал" v={fmtSigned(me.balance + openValue - me.contributed)} vColor={me.balance + openValue - me.contributed >= 0 ? theme.success : theme.danger} />
        </Row>
      </Card>

      {!me.account.emailVerified ? (
        <Card style={{ gap: 10 }}>
          <H2>Имэйл баталгаажуулах</H2>
          <P muted small>Бүртгүүлэхэд {me.account.email} хаяг руу 6 оронтой код илгээсэн. Ирээгүй бол Spam хавтсаа шалгаад дахин илгээ.</P>
          <Field value={code} onChangeText={setCode} placeholder="6 оронтой код" keyboard="number-pad" />
          <Row>
            <Button title="Баталгаажуулах" variant="accent" loading={busy} onPress={() => run(async () => {
              const m = await api<MeDto>('/api/verify', { body: { code } });
              onMe(m);
              return 'Имэйл баталгаажлаа. Одоо таавар тавьж болно!';
            })} />
            <Button title="Дахин илгээх" variant="secondary" loading={busy} onPress={() => run(async () => {
              await api('/api/resend', { body: {} });
              return 'Код дахин илгээгдлээ.';
            })} />
          </Row>
          {msg ? <Msg text={msg.text} kind={msg.kind} /> : null}
        </Card>
      ) : null}

      <Card>
        <H2>Нээлттэй эзэмшил</H2>
        {open.length === 0 ? <P muted>Одоогоор эзэмшил алга.</P> : null}
        {open.map((p, i) => (
          <Row key={`${p.marketId}-${p.outcome}-${i}`} style={{ justifyContent: 'space-between' }}>
            <Text style={s.link} onPress={() => onOpenMarket(p.marketId)} numberOfLines={2}>
              {p.title} — {p.outcomeLabel}
            </Text>
            <P small>
              {fmtShares(p.shares)} хувь ≈ {fmtTokens(p.value)}
            </P>
          </Row>
        ))}
      </Card>

      <Card>
        <H2>Купонууд (экспресс / систем)</H2>
        {data ? <CouponList coupons={data.coupons} /> : null}
      </Card>

      <Card>
        <H2>Дэвтэр</H2>
        {error ? <Msg text={error} /> : !data ? <Loading /> : null}
        {data?.ledger.map((l) => (
          <Row key={l.id} style={{ justifyContent: 'space-between' }}>
            <View style={{ flexShrink: 1 }}>
              <P small>
                {fmtWhen(l.at)} · {KIND_LABEL[l.kind] ?? l.kind}
              </P>
              {l.marketTitle ? <P muted small>{l.marketTitle}</P> : l.note ? <P muted small>{l.note}</P> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: l.delta >= 0 ? theme.success : theme.danger, fontWeight: '700' }}>{fmtSigned(l.delta)}</Text>
              <P muted small>{fmtTokens(l.balanceAfter)}</P>
            </View>
          </Row>
        ))}
      </Card>

      <Card style={{ gap: 8 }}>
        <Text style={s.link} onPress={() => setShowPw((v) => !v)}>
          {showPw ? '▾' : '▸'} Нууц үг солих
        </Text>
        {showPw ? (
          <>
            <Field label="Одоогийн нууц үг" value={oldPw} onChangeText={setOldPw} secure />
            <Field label="Шинэ нууц үг" value={newPw} onChangeText={setNewPw} secure />
            <Button title="Солих" variant="secondary" loading={busy} onPress={() => run(async () => {
              await api('/api/password', { body: { oldPassword: oldPw, newPassword: newPw } });
              setOldPw('');
              setNewPw('');
              return 'Нууц үг солигдлоо.';
            })} />
            {msg && me.account.emailVerified ? <Msg text={msg.text} kind={msg.kind} /> : null}
          </>
        ) : null}
      </Card>
    </ScrollView>
  );
}

export function LeaderboardScreen({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<LeaderboardRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ rows: LeaderboardRowDto[] }>('/api/leaderboard')
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
  }, [refreshKey]);
  if (!rows) return error ? <Msg text={error} /> : <Loading />;
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card>
        <H2>Самбар</H2>
        <P muted small>Нийт = үлдэгдэл + нээлттэй эзэмшлийн үнэлгээ. Ашиг = нийт − оруулсан токен.</P>
        {rows.map((r) => (
          <Row key={r.userId} style={[{ justifyContent: 'space-between', paddingVertical: 4 }, r.me && s.meRow]}>
            <Row>
              <Text style={s.rank}>{r.rank}</Text>
              <Text style={[s.pname, r.me && { color: theme.accent }]}>{r.name}</Text>
            </Row>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: theme.text, fontWeight: '800' }}>{fmtTokens(r.total)}</Text>
              <Text style={{ color: r.pnl >= 0 ? theme.success : theme.danger, fontSize: 12 }}>{fmtSigned(r.pnl)}</Text>
            </View>
          </Row>
        ))}
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 14, paddingBottom: 40 },
  name: { color: theme.text, fontSize: 20, fontWeight: '800' },
  link: { color: theme.accent, fontWeight: '600', flexShrink: 1 },
  rank: { color: theme.muted, width: 26, fontWeight: '700' },
  pname: { color: theme.text, fontWeight: '700', fontSize: 15 },
  meRow: { backgroundColor: theme.raised, borderRadius: 8, paddingHorizontal: 6 },
});
