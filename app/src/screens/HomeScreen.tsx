import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError } from '../api';
import { Button, Card, H2, Loading, Msg, P, Pill, ProbBar, Row } from '../components/ui';
import { fmtTokens, fmtWhen } from '../format';
import type { HomeDto, MarketDto, TournamentDto, WrestlerDto } from '../shared/api';
import { theme } from '../theme';

/** «Баярсайханы Орхонбаяр · Даян аварга · Сэлэнгэ, Цагааннуур · 1998» */
export function wrestlerLine(w: WrestlerDto | undefined): string | undefined {
  if (!w) return undefined;
  const parts = [w.fullName && w.fullName !== w.name ? w.fullName : null, w.titleLabel, w.place, w.birthDate ? w.birthDate.slice(0, 4) : null].filter(Boolean);
  return parts.join(' · ');
}

export function statusPill(m: MarketDto) {
  if (m.status === 'open') return <Pill text="Нээлттэй" color={theme.success} textColor="#052e16" />;
  if (m.status === 'closed') return <Pill text="Хаагдсан" color={theme.warn} textColor="#1a1300" />;
  if (m.status === 'voided') return <Pill text="Хүчингүй" color={theme.raised} />;
  return <Pill text={`Үр дүн: ${m.outcomes[m.resolvedOutcome ?? 0] ?? ''}`} color={theme.raised} textColor={theme.accent} />;
}

export function MarketCard({ m, onOpen }: { m: MarketDto; onOpen: (id: string) => void }) {
  const mine = m.myPosition;
  return (
    <Card onPress={() => onOpen(m.id)} style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={s.mTitle} numberOfLines={2}>
          {m.title}
        </Text>
        {statusPill(m)}
      </Row>
      {m.outcomes.slice(0, 4).map((o, i) => (
        <ProbBar
          key={i}
          label={o}
          sub={m.wrestlers ? wrestlerLine(i === 0 ? m.wrestlers.a : i === 1 ? m.wrestlers.b : undefined) : undefined}
          prob={m.probs[i]}
          model={m.modelProbs?.[i]}
          highlight={m.status === 'resolved' ? m.resolvedOutcome === i : (mine?.[i] ?? 0) > 0.5}
          right={mine && (mine[i] ?? 0) > 0.5 ? `миний ${fmtTokens(mine[i]!)} хувь` : undefined}
        />
      ))}
      {m.outcomes.length > 4 ? <P muted small>… нийт {m.outcomes.length} үр дүн</P> : null}
      <Row style={{ justifyContent: 'space-between' }}>
        <P muted small>
          Эргэлт {fmtTokens(m.volume)} · {m.traders} хүн
        </P>
        {m.closesAt && m.status === 'open' ? <P muted small>хаагдана {fmtWhen(m.closesAt)}</P> : null}
      </Row>
    </Card>
  );
}

/** Тэмцээний карт: даваа/барилдааны төлөв + «Барилдаанууд → бооцоо» товч. */
function TournamentCard({ t, onOpenBoard }: { t: TournamentDto; onOpenBoard: (id: string) => void }) {
  const line = t.finished
    ? `Дууссан · аварга: ${t.championName ?? '?'}`
    : t.currentRound
      ? `${t.currentRound}-р даваа явж байна · ${t.currentTotal} барилдаан · ${t.currentPending} хүлээгдэж буй${t.openMarkets ? ` · ${t.openMarkets} нээлттэй таавар` : ''}`
      : t.entrants
        ? `Эхлээгүй · ${t.entrants} бөх бүртгэлтэй`
        : 'Барилдаан алга';
  const canOpen = t.boutCount > 0;
  return (
    <Card style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={s.mTitle} numberOfLines={2}>
          {t.name}
        </Text>
        {t.currentPending > 0 ? <Pill text="бооцоо нээлттэй" color={theme.success} textColor="#052e16" /> : t.finished ? <Pill text="дууссан" /> : null}
      </Row>
      <P muted small>
        {t.date} · {t.rounds} даваа{t.kind ? ` · ${t.kind}` : ''}
      </P>
      <P small>{line}</P>
      {canOpen ? (
        <Button
          title={t.finished || t.currentPending === 0 ? '🥋 Барилдаанууд, үр дүн →' : '🥋 Барилдаанууд → бооцоо тавих'}
          variant={t.currentPending > 0 ? 'accent' : 'secondary'}
          onPress={() => onOpenBoard(t.id)}
        />
      ) : null}
    </Card>
  );
}

export function HomeScreen({ refreshKey, onOpenMarket, onOpenBoard, onOpenArchive }: { refreshKey: number; onOpenMarket: (id: string) => void; onOpenBoard: (id: string) => void; onOpenArchive: () => void }) {
  const [data, setData] = useState<HomeDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setData(await api<HomeDto>('/api/home'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа');
    }
  };
  useEffect(() => {
    void load();
  }, [refreshKey]);

  if (!data && !error) return <Loading />;
  const open = data?.markets.filter((m) => m.status === 'open' || m.status === 'closed') ?? [];
  const done = data?.markets.filter((m) => m.status === 'resolved' || m.status === 'voided') ?? [];
  const byTournament = new Map<string, MarketDto[]>();
  for (const m of open) {
    const key = m.tournamentName ?? 'Бусад';
    byTournament.set(key, [...(byTournament.get(key) ?? []), m]);
  }
  return (
    <ScrollView
      contentContainerStyle={s.wrap}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={theme.accent}
        />
      }
    >
      <Msg text={error} />
      {data && !data.me.account.emailVerified ? <Msg kind="info" text="Имэйлээ баталгаажуулаагүй байна — таавар тавихын өмнө «Би» хэсгээс кодоо оруулна уу." /> : null}
      {data?.tournaments.length ? (
        <View style={{ gap: 10 }}>
          <H2>Тэмцээнүүд</H2>
          {[...data.tournaments]
            .sort((a, b) => Number(b.currentPending > 0) - Number(a.currentPending > 0) || Number(!b.finished) - Number(!a.finished) || b.date.localeCompare(a.date))
            .map((t) => (
              <TournamentCard key={t.id} t={t} onOpenBoard={onOpenBoard} />
            ))}
        </View>
      ) : (
        <Card>
          <P muted>Одоогоор тэмцээн алга. Админ тэмцээн үүсгэхэд энд гарч ирнэ.</P>
        </Card>
      )}
      {open.length ? <H2>Бусад таавар (хэд давах · хэн холдох · аварга)</H2> : null}
      {[...byTournament.entries()].map(([name, list]) => (
        <View key={name} style={{ gap: 10 }}>
          <P muted small>{name}</P>
          {list
            .sort((a, b) => (b.round ?? 0) - (a.round ?? 0) || b.createdAt.localeCompare(a.createdAt))
            .map((m) => (
              <MarketCard key={m.id} m={m} onOpen={onOpenMarket} />
            ))}
        </View>
      ))}
      {done.length ? (
        <View style={{ gap: 10 }}>
          <H2>Саяхан шийдэгдсэн</H2>
          {done.map((m) => (
            <MarketCard key={m.id} m={m} onOpen={onOpenMarket} />
          ))}
        </View>
      ) : null}
      <Card style={{ gap: 6 }}>
        <H2>Өмнөх тэмцээнүүд — бүх түүх</H2>
        <P muted small>1900 оноос хойших бүх тэмцээний барилдаан бүрийн үр дүн (devjee архив).</P>
        <Button title="📜 Өмнөх бүх барилдааныг үзэх" variant="secondary" onPress={onOpenArchive} />
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 16, paddingBottom: 40 },
  mTitle: { color: theme.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
});
