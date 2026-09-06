import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError } from '../api';
import { Button, Card, Field, H2, Loading, Msg, P, Pill, Row } from '../components/ui';
import { fmtPct, fmtTokens, fmtWhen } from '../format';
import type { AdminUserDto, BoutDto, DevjeeHomeDto, DevjeeSyncStatusDto, ForecastDto, MarketDto, RoundStatusDto, TournamentDetailDto, TournamentDto, WrestlerDto } from '../shared/api';
import { theme } from '../theme';

type Tab = 'tournaments' | 'wrestlers' | 'users' | 'devjee';

const TITLES = [
  'цолгүй', 'залуу_бөх', 'сумын_начин', 'сумын_харцага', 'сумын_заан', 'аймгийн_начин', 'аймгийн_харцага', 'аймгийн_заан', 'аймгийн_арслан',
  'улсын_начин', 'улсын_харцага', 'улсын_заан', 'улсын_гарьд', 'улсын_арслан', 'улсын_аварга', 'даян_аварга', 'дархан_аварга',
];

function useMsg() {
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);
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
  return { msg, busy, run, view: msg ? <Msg text={msg.text} kind={msg.kind} /> : null };
}

export function AdminScreen({ refreshKey, onOpenMarket }: { refreshKey: number; onOpenMarket: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('tournaments');
  return (
    <View style={{ flex: 1 }}>
      <View style={s.tabs}>
        {(
          [
            ['tournaments', 'Тэмцээн'],
            ['wrestlers', 'Бөх'],
            ['users', 'Хэрэглэгч'],
            ['devjee', 'devjee'],
          ] as const
        ).map(([k, label]) => (
          <Text key={k} onPress={() => setTab(k)} style={[s.tab, tab === k && s.tabActive]}>
            {label}
          </Text>
        ))}
      </View>
      {tab === 'tournaments' ? <TournamentsTab refreshKey={refreshKey} onOpenMarket={onOpenMarket} /> : null}
      {tab === 'wrestlers' ? <WrestlersTab refreshKey={refreshKey} /> : null}
      {tab === 'users' ? <UsersTab refreshKey={refreshKey} /> : null}
      {tab === 'devjee' ? <DevjeeTab refreshKey={refreshKey} /> : null}
    </View>
  );
}

// ───────────────────────── Тэмцээн ─────────────────────────

function TournamentsTab({ refreshKey, onOpenMarket }: { refreshKey: number; onOpenMarket: (id: string) => void }) {
  const [list, setList] = useState<TournamentDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rounds, setRounds] = useState('9');
  const [showNew, setShowNew] = useState(false);
  const [genSize, setGenSize] = useState('1024');
  const [genName, setGenName] = useState('');
  const { busy, run, view } = useMsg();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<{ tournaments: TournamentDto[] }>('/api/tournaments')
      .then((d) => setList(d.tournaments))
      .catch(() => setList([]));
  }, [refreshKey, tick]);

  if (selected) return <TournamentDetail id={selected} refreshKey={refreshKey} onBack={() => setSelected(null)} onOpenMarket={onOpenMarket} />;
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card style={{ gap: 8 }}>
        <Text style={s.link} onPress={() => setShowNew((v) => !v)}>
          {showNew ? '▾' : '▸'} Шинэ тэмцээн (гараар)
        </Text>
        {showNew ? (
          <>
            <Field label="Нэр" value={name} onChangeText={setName} autoCapitalize="sentences" />
            <Row>
              <Field label="Огноо (YYYY-MM-DD)" value={date} onChangeText={setDate} style={{ flex: 1 }} />
              <Field label="Даваа" value={rounds} onChangeText={setRounds} keyboard="numeric" style={{ width: 90 }} />
            </Row>
            <Button title="Үүсгэх" variant="accent" loading={busy} onPress={() => run(async () => {
              await api('/api/admin/tournaments', { body: { name, date, rounds: Number(rounds) } });
              setName('');
              setTick((t) => t + 1);
              return 'Тэмцээн үүслээ.';
            })} />
            <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 10 }}>
              <H2>Туршилтын тэмцээн (улс/аймгийн цолтой, идэвхтэй бөхчүүдээс)</H2>
              <P muted small>Рейтингээр топ N бөхийг оролцогч болгоно (2024 оноос хойш барилдсан). Дараа нь тэмцээн дотроос «Даваа эхлүүлэх / дуусгах»-аар удирдана.</P>
              <Row>
                <Field label="Бөхийн тоо" value={genSize} onChangeText={setGenSize} keyboard="numeric" style={{ width: 110 }} />
                <Field label="Нэр (заавал биш)" value={genName} onChangeText={setGenName} style={{ flex: 1 }} autoCapitalize="sentences" />
              </Row>
              <Button title={`Туршилтын тэмцээн үүсгэх (${genSize} бөх)`} variant="secondary" loading={busy} onPress={() => run(async () => {
                const r = await api<{ tournament: TournamentDto; entrants: number; candidates: number }>('/api/admin/tournaments/generate', {
                  body: { size: Number(genSize) || 1024, ...(genName.trim() ? { name: genName.trim() } : {}) },
                });
                setTick((t) => t + 1);
                return `«${r.tournament.name}» үүслээ: ${r.entrants} бөх (${r.tournament.rounds} даваа; шалгуурт ${r.candidates} бөх нийцсэн). Тэмцээн рүү орж 1-р давааг эхлүүл.`;
              })} />
            </View>
            {view}
          </>
        ) : null}
        <P muted small>devjee-ээс импортлохын тулд «devjee» таб.</P>
      </Card>
      {!list ? <Loading /> : null}
      {list?.map((t) => (
        <Card key={t.id} onPress={() => setSelected(t.id)}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={s.cardTitle} numberOfLines={2}>
              {t.name}
            </Text>
            {t.syncEnabled ? <Pill text="devjee sync ●" color={theme.success} textColor="#052e16" /> : null}
          </Row>
          <P muted small>
            {t.date} · {t.rounds} даваа · {t.boutCount} барилдаан · {t.openMarkets} нээлттэй зах зээл{t.devjeeId ? ' · devjee' : ''}
            {t.finished ? ` · дууссан (${t.championName ?? '?'})` : t.currentRound ? ` · ${t.currentRound}-р даваа (${t.currentPending} хүлээгдэж буй)` : t.entrants ? ` · ${t.entrants} бөх, эхлээгүй` : ''}
          </P>
        </Card>
      ))}
    </ScrollView>
  );
}

/** Даваа удирдах: эхлүүлэх (хослол + зах зээл) / дуусгах (үр дүн). */
function RoundControl({ tournamentId, status, roundVolume, onChanged }: { tournamentId: string; status: RoundStatusDto; roundVolume: number; onChanged: () => void }) {
  const { busy, run, view } = useMsg();
  const [pairing, setPairing] = useState<'rank' | 'random'>('rank');
  const [mode, setMode] = useState<'simulate' | 'favorite'>('simulate');
  const [armed, setArmed] = useState<'finish' | 'next' | null>(null);
  const cur = status.current ? status.perRound[status.current - 1] : undefined;
  const nextPairs = Math.floor(status.alive / 2);
  const isFinal = status.current === status.rounds;
  // Буцаагүй үйлдэл — хоёр дарж баталгаажуулна (5 сек дотор)
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  const finishThen = (thenStart: boolean) =>
    run(async () => {
      const r = await api<{ round: number; recorded: number; resolvedMarkets: number; status: RoundStatusDto }>(`/api/admin/tournaments/${tournamentId}/rounds/${status.current}/finish`, { body: { mode } });
      let text = `${r.round}-р даваа дууслаа: ${r.recorded} барилдааны үр дүн гарч ${r.resolvedMarkets} зах зээл шийдэгдэв — давсан бөх дээрх бооцоонууд төлбөртэйгөө үлдэгдэлд орлоо${r.status.finished ? ` · АВАРГА: ${r.status.championName}` : ` · амьд ${r.status.alive} бөх`}.`;
      if (thenStart && r.status.next) {
        const s = await api<{ round: number; bouts: number; markets: number; byes: string[] }>(`/api/admin/tournaments/${tournamentId}/rounds/${r.status.next}/start`, { body: { pairing } });
        text += ` ${s.round}-р даваа эхэллээ: ${s.bouts} барилдаан нээлттэй${s.byes.length ? ` · гоц: ${s.byes.join(', ')}` : ''}.`;
      }
      onChanged();
      return text;
    });
  return (
    <Card style={{ gap: 8 }}>
      <H2>Даваа удирдах</H2>
      <Row gap={6}>
        {status.perRound.map((r) => (
          <Pill
            key={r.round}
            text={`${r.round}: ${r.total ? `${r.total - r.pending}/${r.total}` : '—'}`}
            color={r.total === 0 ? theme.raised : r.pending ? theme.warn : theme.success}
            textColor={r.total === 0 ? theme.muted : '#052e16'}
          />
        ))}
      </Row>
      <P small>
        {status.finished
          ? `Тэмцээн дууссан — аварга ${status.championName ?? '?'}.`
          : status.current
            ? `${status.current}-р даваа: ${cur?.total ?? 0} барилдаан, ${cur?.pending ?? 0} хүлээгдэж буй · амьд ${status.alive} бөх`
            : `Эхлээгүй · ${status.entrants} бөх бүртгэлтэй`}
      </P>
      {status.next ? (
        <View style={{ gap: 6 }}>
          <View style={s.stepBox}>
            <P small>
              <Text style={{ fontWeight: '800' }}>{status.current ? `${status.current}-р даваа дууссан` : 'Тэмцээн эхлээгүй'}</Text> — дараагийн алхам: {status.next}-р давааг эхлүүлэхэд {status.alive} амьд бөх хослогдож {nextPairs} барилдаан + зах зээл нээгдэнэ; хэрэглэгчид «Барилдаанууд → бооцоо тавих» дээр шууд харна.
            </P>
          </View>
          <Row>
            <P muted small>Хослол:</P>
            <Button small title="Оноолт (дээд↔доод)" variant={pairing === 'rank' ? 'accent' : 'secondary'} onPress={() => setPairing('rank')} />
            <Button small title="Санамсаргүй" variant={pairing === 'random' ? 'accent' : 'secondary'} onPress={() => setPairing('random')} />
          </Row>
          <Button
            title={`▶ ${status.next}-р давааг эхлүүлэх — ${nextPairs} барилдаан (${status.alive} бөх)${status.alive % 2 ? ', 1 гоц' : ''}`}
            variant="accent"
            loading={busy}
            onPress={() => run(async () => {
              const r = await api<{ round: number; bouts: number; markets: number; byes: string[] }>(`/api/admin/tournaments/${tournamentId}/rounds/${status.next}/start`, { body: { pairing } });
              onChanged();
              return `${r.round}-р даваа эхэллээ: ${r.bouts} барилдаан, ${r.markets} зах зээл нээгдэв${r.byes.length ? ` · гоц: ${r.byes.join(', ')}` : ''}. Хэрэглэгчид «Барилдаанууд → бооцоо» дээр харна.`;
            })}
          />
        </View>
      ) : null}
      {cur && cur.pending > 0 ? (
        <View style={{ gap: 8 }}>
          <View style={s.stepBox}>
            <P small>
              <Text style={{ fontWeight: '800' }}>Одоо: {status.current}-р даваанд бооцоо авч байна</Text> — {cur.pending} барилдаан хүлээгдэж буй{roundVolume ? `, нийт ${fmtTokens(roundVolume)} токен бооцоо` : ''}.
            </P>
            <P muted small>
              Дараагийн алхам: давааг <Text style={{ fontWeight: '800', color: theme.text }}>дуусгах</Text> → барилдаан бүрийн үр дүн гарна, давсан бөх дээрх бооцоо төлбөртэйгөө (давбал ×коэфф.) хэрэглэгчийн үлдэгдэлд буцаж орно, унасан нь алдагдана → {isFinal ? 'аварга тодорно' : 'дараагийн давааны хосууд гарч бооцоо дахин нээгдэнэ'}.
            </P>
          </View>
          <Row>
            <P muted small>Үр дүн:</P>
            <Button small title="Загвараар санамсаргүй" variant={mode === 'simulate' ? 'accent' : 'secondary'} onPress={() => setMode('simulate')} />
            <Button small title="Рейтинг өндөр нь давна" variant={mode === 'favorite' ? 'accent' : 'secondary'} onPress={() => setMode('favorite')} />
          </Row>
          {!isFinal ? (
            <Row>
              <P muted small>Дараагийн хослол:</P>
              <Button small title="Оноолт (дээд↔доод)" variant={pairing === 'rank' ? 'accent' : 'secondary'} onPress={() => setPairing('rank')} />
              <Button small title="Санамсаргүй" variant={pairing === 'random' ? 'accent' : 'secondary'} onPress={() => setPairing('random')} />
            </Row>
          ) : null}
          <Button
            title={
              armed === 'next'
                ? '⚠ Итгэлтэй байна уу? Дахин дарж баталгаажуул'
                : isFinal
                  ? `⏭ Финалыг дуусгах — аварга тодруулах`
                  : `⏭ ${status.current}-р давааг дуусгаад ${status.current + 1}-р давааг эхлүүлэх`
            }
            variant="accent"
            loading={busy}
            onPress={() => {
              if (armed !== 'next') {
                setArmed('next');
                return;
              }
              setArmed(null);
              void finishThen(!isFinal);
            }}
          />
          <Button
            small
            title={armed === 'finish' ? '⚠ Дахин дарж баталгаажуул' : `■ Зөвхөн ${status.current}-р давааг дуусгах (үр дүн, төлбөр) — дараагийнхыг дараа эхлүүлнэ`}
            variant="secondary"
            loading={busy}
            onPress={() => {
              if (armed !== 'finish') {
                setArmed('finish');
                return;
              }
              setArmed(null);
              void finishThen(false);
            }}
          />
          <P muted small>Туршилтад үр дүнг загвараар (Elo магадлал) сугална; бодит тэмцээнд devjee sync-ээс ирнэ. Тодорхой барилдааныг доорх «Үр дүн гараар бүртгэх» жагсаалтаас өмнө нь бүртгэж болно.</P>
        </View>
      ) : null}
      {view}
    </Card>
  );
}

/** devjee автомат шинэчлэлийн (sync) төлөв + удирдлага — тэмцээний дэлгэц дээр. */
function DevjeeSyncCard({ tournamentId, enabled, tick, onChanged }: { tournamentId: string; enabled: boolean; tick: number; onChanged: () => void }) {
  const [st, setSt] = useState<DevjeeSyncStatusDto | null>(null);
  const { busy, run, view } = useMsg();
  useEffect(() => {
    api<{ statuses: DevjeeSyncStatusDto[] }>('/api/admin/devjee/status')
      .then((d) => setSt(d.statuses.find((x) => x.tournamentId === tournamentId) ?? null))
      .catch(() => setSt(null));
  }, [tournamentId, tick]);
  const on = st ? st.enabled : enabled;
  return (
    <Card style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H2>devjee sync — автомат шинэчлэл</H2>
        <Pill text={on ? 'асаалттай ●' : 'унтраалттай'} color={on ? theme.success : theme.border} textColor={on ? '#052e16' : theme.text} />
      </Row>
      <P muted small>
        {on ? '30 секунд тутам' : 'Асаавал 30 секунд тутам'} devjee.mn-ээс энэ тэмцээний төлөвийг татаж: шинэ хослол → барилдааны зах зээл автоматаар нээгдэнэ; давсан бөх бичигдэхэд → зах зээл шийдэгдэж төлбөр тархана, Elo шинэчлэгдэнэ; гоц (ирээгүй) → зах зээл хүчингүй, буцаалт. Гараар юу ч хийх шаардлагагүй.
      </P>
      {st ? (
        <P muted small>
          Барилдаан {st.bouts} (шийдсэн {st.resolved}) · бөх {st.wrestlers} · {st.lastSyncAt ? `сүүлд ${fmtWhen(st.lastSyncAt)}` : 'sync хийгээгүй'}
          {st.lastError ? ` · алдаа: ${st.lastError}` : ''}
        </P>
      ) : null}
      <Row>
        <Button small title="Одоо sync" variant="accent" loading={busy} onPress={() => run(async () => {
          const r = await api<{ result: { newBouts: number; resolved: number; voided: number } | null }>(`/api/admin/devjee/sync/${tournamentId}`, { body: { now: true } });
          onChanged();
          return `Шинэ барилдаан ${r.result?.newBouts ?? 0}, шийдсэн ${r.result?.resolved ?? 0}, хүчингүй ${r.result?.voided ?? 0}.`;
        })} />
        <Button small title={on ? 'Sync унтраах' : 'Sync асаах'} variant={on ? 'danger' : 'secondary'} loading={busy} onPress={() => run(async () => {
          await api(`/api/admin/devjee/sync/${tournamentId}`, { body: { enabled: !on } });
          onChanged();
          return on ? 'Sync унтарлаа — devjee-ээс автоматаар татахаа болино.' : 'Sync асаалаа — 30 сек тутам шалгана.';
        })} />
      </Row>
      {view}
    </Card>
  );
}

function TournamentDetail({ id, refreshKey, onBack, onOpenMarket }: { id: string; refreshKey: number; onBack: () => void; onOpenMarket: (id: string) => void }) {
  const [data, setData] = useState<TournamentDetailDto | null>(null);
  const [tick, setTick] = useState(0);
  const { busy, run, view } = useMsg();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<WrestlerDto[]>([]);
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [round, setRound] = useState('1');
  const [customTitle, setCustomTitle] = useState('');
  const [customOutcomes, setCustomOutcomes] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [forecast, setForecast] = useState<ForecastDto | null>(null);
  const [line, setLine] = useState('4.5');
  const [topK, setTopK] = useState('8');

  const load = () =>
    api<TournamentDetailDto>(`/api/tournaments/${id}`)
      .then(setData)
      .catch(() => setData(null));
  useEffect(() => {
    void load();
  }, [id, refreshKey, tick]);
  useEffect(() => {
    const q = aId && bId ? `&aId=${encodeURIComponent(aId)}&bId=${encodeURIComponent(bId)}` : aId ? `&wrestlerId=${encodeURIComponent(aId)}` : '';
    api<ForecastDto>(`/api/tournaments/${id}/forecast?top=10${q}`)
      .then(setForecast)
      .catch(() => setForecast(null));
  }, [id, tick, aId, bId]);

  const ruleMarket = (rule: Record<string, unknown>) =>
    run(async () => {
      const r = await api<{ market: MarketDto }>('/api/admin/markets/rule', { body: { rule } });
      setTick((x) => x + 1);
      return `Нээгдлээ: ${r.market.title}`;
    });

  useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    api<{ wrestlers: WrestlerDto[] }>(`/api/wrestlers?q=${encodeURIComponent(q.trim())}&limit=8`)
      .then((d) => setFound(d.wrestlers))
      .catch(() => setFound([]));
  }, [q]);

  if (!data) return <Loading />;
  const t = data.tournament;
  const marketOf = (b: BoutDto): MarketDto | undefined => data.markets.find((m) => m.boutId === b.id);
  const boutsByRound = new Map<number, BoutDto[]>();
  for (const b of data.bouts) boutsByRound.set(b.round, [...(boutsByRound.get(b.round) ?? []), b]);
  const pending = data.bouts.filter((b) => !b.winnerId);

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.link} onPress={onBack}>
        ← Тэмцээнүүд
      </Text>
      <Card>
        <Text style={s.cardTitle}>{t.name}</Text>
        <P muted small>
          {t.date} · {t.rounds} даваа · {t.boutCount} барилдаан{t.devjeeId ? ` · devjee ${t.devjeeId}` : ''}
        </P>
      </Card>

      {t.devjeeId ? <DevjeeSyncCard tournamentId={t.id} enabled={t.syncEnabled} tick={tick} onChanged={() => setTick((x) => x + 1)} /> : null}

      {!t.devjeeId ? (
        <RoundControl
          tournamentId={t.id}
          status={data.status}
          roundVolume={data.markets.filter((m) => m.kind === 'bout' && m.round === data.status.current).reduce((a, m) => a + m.volume, 0)}
          onChanged={() => setTick((x) => x + 1)}
        />
      ) : null}

      {forecast ? (
        <Card style={{ gap: 6 }}>
          <H2>Прогноз (Монте-Карло, {forecast.sims} симуляци, {forecast.entrants} бөх{forecast.finished ? ', тэмцээн дууссан' : ''})</H2>
          {forecast.champions.map((c, i) => (
            <Row key={c.id} style={{ justifyContent: 'space-between' }}>
              <P small>
                {i + 1}. {c.name} · {c.titleLabel}
                {c.place ? ` · ${c.place}` : ''} · Elo {c.rating}
                {c.eliminated !== undefined ? ` · унасан` : ''}
              </P>
              <P small>
                {fmtPct(c.pChampion, 1)} · {c.expectedWins.toFixed(1)} даваа
              </P>
            </Row>
          ))}
          {forecast.finished ? (
            <P muted small>Тэмцээн дууссан — аварга: {forecast.champions[0]?.name ?? '?'}. Дүрэмт зах зээлүүд бүгд автоматаар шийдэгдсэн.</P>
          ) : (
            <Row>
              <Field label="Топ K" value={topK} onChangeText={setTopK} keyboard="numeric" style={{ width: 80 }} />
              <Button small title={`Аварга зах зээл нээх (топ ${topK} + Бусад)`} variant="accent" loading={busy} onPress={() => ruleMarket({ type: 'champion', tournamentId: t.id, topK: Number(topK) || 8 })} />
            </Row>
          )}
        </Card>
      ) : null}

      <Card style={{ gap: 8 }}>
        <H2>Барилдаан нэмэх (зах зээл шууд нээгдэнэ)</H2>
        <Field label="Бөх хайх (нэр, цол, аймаг, сум)" value={q} onChangeText={setQ} placeholder="Орхон… / улсын заан ховд" />
        {found.length ? (
          <Row>
            {found.map((w) => (
              <Button key={w.id} small variant="secondary" title={`${w.name} (${w.rating})`} onPress={() => (!aId ? setAId(w.id) : setBId(w.id))} />
            ))}
          </Row>
        ) : null}
        <Row>
          <Field label="А бөх (id)" value={aId} onChangeText={setAId} style={{ flex: 1 }} />
          <Field label="Б бөх (id)" value={bId} onChangeText={setBId} style={{ flex: 1 }} />
          <Field label="Даваа" value={round} onChangeText={setRound} keyboard="numeric" style={{ width: 70 }} />
        </Row>
        <Button title="Барилдаан + зах зээл нээх" variant="accent" loading={busy} onPress={() => run(async () => {
          await api('/api/admin/bouts', { body: { tournamentId: t.id, round: Number(round), aId, bId } });
          setAId('');
          setBId('');
          setTick((x) => x + 1);
          return 'Нээгдлээ.';
        })} />
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 10 }}>
          <H2>Загварууд (прогнозоор автомат үнэлэгдэж, тэмцээний явцаас автомат шийдэгдэнэ)</H2>
          {forecast?.wrestler ? (
            <P muted small>
              {forecast.wrestler.name}: хүлээгдэж буй {forecast.wrestler.expectedWins.toFixed(1)} даваа · тархалт {forecast.wrestler.dist.map((p, k) => `${k}:${Math.round(p * 100)}%`).join(' ')}
              {forecast.wrestler.eliminated !== undefined ? ` · унасан (${forecast.wrestler.eliminated} давсан)` : ''}
            </P>
          ) : null}
          <Row>
            <Field label="Босго (N.5)" value={line} onChangeText={setLine} keyboard="numeric" style={{ width: 110 }} />
            <Button small title="Хэд давах: А босгоос дээш/доош" variant="secondary" loading={busy} disabled={!aId} onPress={() => ruleMarket({ type: 'wins_over', tournamentId: t.id, wrestlerId: aId, line: Number(line) })} />
            <Button small title="Яг хэд давах: А" variant="secondary" loading={busy} disabled={!aId} onPress={() => ruleMarket({ type: 'wins_exact', tournamentId: t.id, wrestlerId: aId })} />
            <Button small title="Хэн холдох: А — Б" variant="secondary" loading={busy} disabled={!aId || !bId} onPress={() => ruleMarket({ type: 'matchup', tournamentId: t.id, aId, bId })} />
          </Row>
          {forecast?.matchup ? (
            <P muted small>
              Прогноз: А {fmtPct(forecast.matchup.probs[0])} · Б {fmtPct(forecast.matchup.probs[1])} · тэнцүү {fmtPct(forecast.matchup.probs[2])}
            </P>
          ) : null}
        </View>
        <Text style={s.link} onPress={() => setShowCustom((v) => !v)}>
          {showCustom ? '▾' : '▸'} Олон үр дүнтэй зах зээл (жишээ: аварга хэн болох)
        </Text>
        {showCustom ? (
          <>
            <Field label="Гарчиг" value={customTitle} onChangeText={setCustomTitle} autoCapitalize="sentences" />
            <Field label="Үр дүнгүүд (таслалаар)" value={customOutcomes} onChangeText={setCustomOutcomes} placeholder="Б.Орхонбаяр, Э.Батмагнай, Бусад" autoCapitalize="sentences" />
            <Button title="Зах зээл нээх" variant="secondary" loading={busy} onPress={() => run(async () => {
              const outcomes = customOutcomes.split(',').map((x) => x.trim()).filter(Boolean);
              await api('/api/admin/markets', { body: { title: customTitle, outcomes, tournamentId: t.id, b: 4000 } });
              setCustomTitle('');
              setCustomOutcomes('');
              setTick((x) => x + 1);
              return 'Зах зээл нээгдлээ.';
            })} />
          </>
        ) : null}
        {view}
      </Card>

      {pending.length >= 2 ? (
        <Card style={{ gap: 8 }}>
          <H2>Багц таавар үүсгэх (пул, 60/30/10)</H2>
          <P muted small>Хүлээгдэж буй {pending.length} барилдаанаас эхний {Math.min(16, pending.length)}-г авна. Оролцооны хураамж 100 токен.</P>
          <Button
            small
            title={`Багц таавар үүсгэх (${Math.min(16, pending.length)} барилдаан)`}
            variant="accent"
            loading={busy}
            onPress={() =>
              run(async () => {
                const boutIds = pending.slice(0, 16).map((b) => b.id);
                await api('/api/admin/totos', { body: { title: `${t.name} — багц таавар`, tournamentId: t.id, boutIds, fee: 100 } });
                setTick((x) => x + 1);
                return 'Багц таавар нээгдлээ — «🎟 Багц таавар» табаас харагдана.';
              })
            }
          />
        </Card>
      ) : null}

      {pending.length ? (
        <Card style={{ gap: 8 }}>
          <H2>Үр дүн гараар бүртгэх ({pending.length} хүлээгдэж буй{pending.length > 30 ? ', эхний 30-ыг харуулав' : ''})</H2>
          {pending.slice(0, 30).map((b) => (
            <View key={b.id} style={s.boutRow}>
              <P small>
                {b.round}-р даваа: {b.a.name} ({fmtPct(b.priorA ?? 0.5)}) — {b.b.name}
              </P>
              <Row>
                <Button small title={`${b.a.name} давав`} variant="secondary" loading={busy} onPress={() => run(async () => {
                  await api(`/api/admin/bouts/${b.id}/result`, { body: { winnerId: b.a.id } });
                  setTick((x) => x + 1);
                  return `${b.a.name} давлаа — зах зээл шийдэгдэв.`;
                })} />
                <Button small title={`${b.b.name} давав`} variant="secondary" loading={busy} onPress={() => run(async () => {
                  await api(`/api/admin/bouts/${b.id}/result`, { body: { winnerId: b.b.id } });
                  setTick((x) => x + 1);
                  return `${b.b.name} давлаа — зах зээл шийдэгдэв.`;
                })} />
                {marketOf(b) && marketOf(b)!.status !== 'voided' ? (
                  <Button small title="Хүчингүй" variant="danger" loading={busy} onPress={() => run(async () => {
                    await api(`/api/admin/markets/${marketOf(b)!.id}/void`, { body: { reason: 'Бөх ирээгүй' } });
                    setTick((x) => x + 1);
                    return 'Хүчингүй болгож буцаалт хийв.';
                  })} />
                ) : null}
              </Row>
            </View>
          ))}
        </Card>
      ) : null}

      <Card style={{ gap: 6 }}>
        <H2>Зах зээлүүд ({data.markets.length}; барилдааных самбар дээр — энд дүрэмт/бусад ба хаагдсан)</H2>
        {data.markets
          .filter((m) => m.kind === 'custom' || m.status === 'closed')
          .slice(0, 40)
          .map((m) => (
            <View key={m.id} style={s.boutRow}>
              <Text style={s.link} onPress={() => onOpenMarket(m.id)} numberOfLines={2}>
                {m.title}
              </Text>
              <Row>
                <Pill text={m.status} />
                {m.status === 'open' ? (
                  <Button small title="Хаах" variant="secondary" loading={busy} onPress={() => run(async () => {
                    await api(`/api/admin/markets/${m.id}/close`, { body: {} });
                    setTick((x) => x + 1);
                    return 'Хаалаа.';
                  })} />
                ) : null}
                {m.kind === 'custom' && (m.status === 'open' || m.status === 'closed')
                  ? m.outcomes.map((o, i) => (
                      <Button key={i} small title={`✓ ${o}`} variant="secondary" loading={busy} onPress={() => run(async () => {
                        await api(`/api/admin/markets/${m.id}/resolve`, { body: { outcome: i } });
                        setTick((x) => x + 1);
                        return `«${o}» гэж шийдэв.`;
                      })} />
                    ))
                  : null}
                {m.status === 'open' || m.status === 'closed' ? (
                  <Button small title="Хүчингүй" variant="danger" loading={busy} onPress={() => run(async () => {
                    await api(`/api/admin/markets/${m.id}/void`, { body: { reason: 'админ хүчингүй болгов' } });
                    setTick((x) => x + 1);
                    return 'Хүчингүй.';
                  })} />
                ) : null}
              </Row>
            </View>
          ))}
      </Card>

      {[...boutsByRound.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([r, list]) => (
          <Card key={r} style={{ gap: 4 }}>
            <H2>
              {r}-р даваа · {list.length} барилдаан · {list.filter((b) => b.winnerId).length} дууссан
            </H2>
            {list.slice(0, 16).map((b) => (
              <P key={b.id} small>
                {b.a.name} — {b.b.name}
                {b.winnerId ? ` → ${b.winnerId === b.a.id ? b.a.name : b.b.name} давсан` : ' (хүлээгдэж буй)'}
              </P>
            ))}
            {list.length > 16 ? <P muted small>… бүгдийг (хосоор, үр дүнтэй) «Зах зээл» → тэмцээн → «Барилдаанууд» самбараас харна.</P> : null}
          </Card>
        ))}
    </ScrollView>
  );
}

// ───────────────────────── Бөх ─────────────────────────

function WrestlersTab({ refreshKey }: { refreshKey: number }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<WrestlerDto[]>([]);
  const [total, setTotal] = useState(0);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('улсын_начин');
  const [aimag, setAimag] = useState('');
  const [rating, setRating] = useState('');
  const { busy, run, view } = useMsg();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<{ wrestlers: WrestlerDto[]; total: number }>(`/api/wrestlers?q=${encodeURIComponent(q)}&limit=40`)
      .then((d) => {
        setList(d.wrestlers);
        setTotal(d.total);
      })
      .catch(() => setList([]));
  }, [q, refreshKey, tick]);
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card style={{ gap: 8 }}>
        <H2>devjee архиваас бүх бөхийг оруулах</H2>
        <P muted small>Архивт байгаа бүх бөх (≈21 900) — овог нэр, цол, нутаг, өндөр/жин, дэвжээ, харьяалал, цолын түүх + devjee масштабын Elo. Дахин дарахад зөвхөн дутууг нөхнө.</P>
        <Button title="Бүх бөхийг оруулах" variant="accent" loading={busy} onPress={() => run(async () => {
          const r = await api<{ added: number; updated: number; rated: number; skipped: number; wrestlers: number; seconds: number }>('/api/admin/import-archive', { body: {} });
          setTick((x) => x + 1);
          return `Нэмсэн ${r.added}, нөхсөн ${r.updated}, рейтинг ${r.rated}, өөрчлөлтгүй ${r.skipped} · нийт ${r.wrestlers} бөх · ${r.seconds} сек`;
        })} />
        {view}
      </Card>
      <Card style={{ gap: 8 }}>
        <H2>Бөх нэмэх (гараар)</H2>
        <Field label="Нэр (жишээ: Б.Орхонбаяр)" value={name} onChangeText={setName} autoCapitalize="words" />
        <Row>
          {TITLES.map((t) => (
            <Button key={t} small title={t.replace('_', ' ')} variant={title === t ? 'accent' : 'secondary'} onPress={() => setTitle(t)} />
          ))}
        </Row>
        <Row>
          <Field label="Аймаг" value={aimag} onChangeText={setAimag} style={{ flex: 1 }} autoCapitalize="words" />
          <Field label="Elo (заавал биш)" value={rating} onChangeText={setRating} keyboard="numeric" style={{ width: 120 }} />
        </Row>
        <Button title="Нэмэх" variant="accent" loading={busy} onPress={() => run(async () => {
          await api('/api/admin/wrestlers', { body: { name, title, aimag: aimag || undefined, rating: rating ? Number(rating) : undefined } });
          setName('');
          setRating('');
          setTick((x) => x + 1);
          return 'Нэмэгдлээ.';
        })} />
      </Card>
      <Card>
        <Field label={`Хайх (${total} бөх) — нэр, овог, цол, аймаг, сум; үгсийг хольж болно`} value={q} onChangeText={setQ} placeholder="жишээ: улсын заан ховд · сумъяа алтай · аймгийн арслан" />
        {list.map((w) => (
          <Row key={w.id} style={{ justifyContent: 'space-between' }}>
            <P small>
              {w.name} · {w.titleLabel}
              {w.place ? ` · ${w.place}` : ''}
            </P>
            <P small muted>
              {w.rating} ({w.ratingSource})
            </P>
          </Row>
        ))}
      </Card>
    </ScrollView>
  );
}

// ───────────────────────── Хэрэглэгч ─────────────────────────

function UsersTab({ refreshKey }: { refreshKey: number }) {
  const [users, setUsers] = useState<AdminUserDto[] | null>(null);
  const [amount, setAmount] = useState('5000');
  const { busy, run, view } = useMsg();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<{ users: AdminUserDto[] }>('/api/admin/users')
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, [refreshKey, tick]);
  if (!users) return <Loading />;
  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card style={{ gap: 8 }}>
        <Field label="Олгох токен" value={amount} onChangeText={setAmount} keyboard="numeric" />
        {view}
      </Card>
      {users.map((u) => (
        <Card key={u.account.id} style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={s.cardTitle}>{u.account.username}</Text>
              <P muted small>
                {u.account.email} · {u.account.emailVerified ? 'баталгаажсан' : 'баталгаажаагүй'} · {u.account.role}
              </P>
            </View>
            <Text style={{ color: theme.accent, fontWeight: '800' }}>{fmtTokens(u.balance)}</Text>
          </Row>
          <Row>
            <Button small title={`+${fmtTokens(Number(amount) || 0)}`} variant="secondary" loading={busy} onPress={() => run(async () => {
              await api('/api/admin/grant', { body: { userId: u.account.id, amount: Number(amount), reason: 'админы олголт' } });
              setTick((x) => x + 1);
              return `${u.account.username}-д олголоо.`;
            })} />
            {u.account.role === 'member' ? (
              <Button small title="Админ болгох" variant="secondary" loading={busy} onPress={() => run(async () => {
                await api('/api/admin/role', { body: { userId: u.account.id, role: 'admin' } });
                setTick((x) => x + 1);
                return 'Админ боллоо.';
              })} />
            ) : null}
          </Row>
        </Card>
      ))}
    </ScrollView>
  );
}

// ───────────────────────── devjee ─────────────────────────

function DevjeeTab({ refreshKey }: { refreshKey: number }) {
  const [home, setHome] = useState<DevjeeHomeDto | null>(null);
  const [statuses, setStatuses] = useState<DevjeeSyncStatusDto[]>([]);
  const [tid, setTid] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run, view } = useMsg();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<DevjeeHomeDto>('/api/admin/devjee/home')
      .then((h) => {
        setHome(h);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
    api<{ statuses: DevjeeSyncStatusDto[] }>('/api/admin/devjee/status')
      .then((d) => setStatuses(d.statuses))
      .catch(() => setStatuses([]));
  }, [refreshKey, tick]);

  const doImport = (id: string) =>
    run(async () => {
      const r = await api<{ imported: { wrestlersAdded: number; ratingsFromTop: number; ratingsFromMatches: number } }>('/api/admin/devjee/import', { body: { tid: id } });
      setTick((x) => x + 1);
      return `Импорт: бөх +${r.imported.wrestlersAdded}, рейтинг топ ${r.imported.ratingsFromTop}, түүхээс ${r.imported.ratingsFromMatches}. Одоо «Тэмцээн» табаас sync асаа.`;
    });

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card style={{ gap: 8 }}>
        <H2>devjee.mn-ээс тэмцээн импортлох</H2>
        <P muted small>Импорт: тэмцээн + бүртгэгдсэн бөхчүүд + Elo рейтинг. Дараа нь sync асаавал 30 сек тутам шинэ хослол → зах зээл, үр дүн → шийдвэр автоматаар.</P>
        <Row>
          <Field label="devjee тэмцээний id (URL-ийн /t/… хэсэг)" value={tid} onChangeText={setTid} style={{ flex: 1 }} />
          <Button title="Импорт" variant="accent" loading={busy} onPress={() => doImport(tid.trim())} disabled={!tid.trim()} />
        </Row>
        {view}
        <Msg text={error} />
      </Card>
      {home ? (
        <Card style={{ gap: 6 }}>
          <H2>Товлогдсон / сүүлийн тэмцээнүүд</H2>
          {[...home.scheduled, ...home.recent].map((t) => (
            <Row key={t.id} style={{ justifyContent: 'space-between' }}>
              <View style={{ flexShrink: 1 }}>
                <P small>{t.name}</P>
                <P muted small>
                  {t.date}
                  {t.place ? ` · ${t.place}` : ''} · {t.id}
                </P>
              </View>
              {t.imported ? <Pill text="орсон" color={theme.success} textColor="#052e16" /> : <Button small title="Импорт" variant="secondary" loading={busy} onPress={() => doImport(t.id)} />}
            </Row>
          ))}
        </Card>
      ) : null}
      {statuses.length ? (
        <Card style={{ gap: 8 }}>
          <H2>Sync төлөв</H2>
          {statuses.map((st) => (
            <View key={st.tournamentId} style={s.boutRow}>
              <P small>
                {st.tournamentId} · барилдаан {st.bouts} (шийдсэн {st.resolved}) · {st.lastSyncAt ? `сүүлд ${fmtWhen(st.lastSyncAt)}` : 'хийгээгүй'}
                {st.lastError ? ` · алдаа: ${st.lastError}` : ''}
              </P>
              <Row>
                <Button small title={st.enabled ? 'Sync унтраах' : 'Sync асаах'} variant={st.enabled ? 'danger' : 'accent'} loading={busy} onPress={() => run(async () => {
                  await api(`/api/admin/devjee/sync/${st.tournamentId}`, { body: { enabled: !st.enabled } });
                  setTick((x) => x + 1);
                  return st.enabled ? 'Sync унтарлаа.' : 'Sync асаалаа — 30 сек тутам шалгана.';
                })} />
                <Button small title="Одоо sync" variant="secondary" loading={busy} onPress={() => run(async () => {
                  const r = await api<{ result: { newBouts: number; resolved: number; voided: number } | null }>(`/api/admin/devjee/sync/${st.tournamentId}`, { body: { now: true } });
                  setTick((x) => x + 1);
                  return `Шинэ ${r.result?.newBouts ?? 0}, шийдсэн ${r.result?.resolved ?? 0}, хүчингүй ${r.result?.voided ?? 0}.`;
                })} />
              </Row>
            </View>
          ))}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 14, paddingBottom: 40 },
  tabs: { flexDirection: 'row', backgroundColor: theme.surface, borderBottomWidth: 1, borderBottomColor: theme.border },
  tab: { flex: 1, textAlign: 'center', paddingVertical: 10, color: theme.muted, fontWeight: '700' },
  tabActive: { color: theme.accent, borderBottomWidth: 2, borderBottomColor: theme.accent },
  link: { color: theme.accent, fontWeight: '700' },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  boutRow: { gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.border },
  stepBox: { backgroundColor: theme.raised, borderRadius: 10, padding: 10, gap: 4, borderLeftWidth: 3, borderLeftColor: theme.accent },
});
