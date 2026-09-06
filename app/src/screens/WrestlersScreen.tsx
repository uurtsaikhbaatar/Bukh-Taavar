/**
 * Бөхчүүд — бүх 22 мянган бөхөөс хайж, профайл + бүх барилдааны түүхийг үзнэ.
 * Хайлт: нэр/овог/цол/аймаг/сум үгсээр (AND). Түүх devjee-ийн архиваас (247к барилдаан).
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, ApiError } from '../api';
import { Button, Card, H2, KV, Loading, Msg, P, Pill, Row } from '../components/ui';
import { fmtTokens } from '../format';
import type { WrestlerBoutsDto, WrestlerDetailDto, WrestlerDto } from '../shared/api';
import { theme } from '../theme';

function WrestlerProfile({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [data, setData] = useState<WrestlerDetailDto | null>(null);
  const [bouts, setBouts] = useState<WrestlerBoutsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setData(null);
    setBouts(null);
    api<WrestlerDetailDto>(`/api/wrestlers/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
    api<WrestlerBoutsDto>(`/api/wrestlers/${encodeURIComponent(id)}/bouts?limit=50`)
      .then(setBouts)
      .catch(() => setBouts(null));
  }, [id]);

  if (!data && !error) return <Loading />;
  if (!data) return <Msg text={error} />;
  const w = data.wrestler;
  const bio = [
    w.birthDate ? `төрсөн ${w.birthDate.slice(0, 4)}` : null,
    w.height ? `${w.height} см` : null,
    w.weight ? `${w.weight} кг` : null,
    w.club ? `дэвжээ: ${w.club}` : null,
  ].filter(Boolean).join(' · ');

  const more = async () => {
    if (!bouts) return;
    setLoadingMore(true);
    try {
      const next = await api<WrestlerBoutsDto>(`/api/wrestlers/${encodeURIComponent(id)}/bouts?offset=${bouts.rows.length}&limit=50`);
      setBouts({ ...next, rows: [...bouts.rows, ...next.rows] });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.back} onPress={onBack}>← Бөхчүүд</Text>
      <Card style={{ gap: 6 }}>
        <Text style={s.name}>{w.fullName && w.fullName !== w.name ? w.fullName : w.name}</Text>
        <Row gap={6}>
          <Pill text={w.titleLabel} color={theme.accent} textColor={theme.accentText} />
          {w.place ? <P muted small>{w.place}</P> : null}
        </Row>
        {bio ? <P muted small>{bio}</P> : null}
        {w.affiliations?.length ? <P muted small>{w.affiliations.join(' · ')}</P> : null}
        <Row gap={16}>
          <KV k="Рейтинг" v={String(w.rating)} />
          {data.record ? <KV k="Давалт" v={String(data.record.wins)} vColor={theme.success} /> : null}
          {data.record ? <KV k="Алдагдал" v={String(data.record.losses)} vColor={theme.danger} /> : null}
          {data.record ? <KV k="Давалтын хувь" v={`${Math.round((data.record.wins / Math.max(1, data.record.wins + data.record.losses)) * 100)}%`} /> : null}
        </Row>
      </Card>

      {w.titles?.length ? (
        <Card style={{ gap: 4 }}>
          <H2>Цолын түүх</H2>
          {w.titles.map((t, i) => (
            <P key={i} small>
              {t.date.slice(0, 4)} — {t.titleLabel}
              {t.place ? ` (${t.place})` : ''}
              {t.rounds ? ` · ${t.rounds}` : ''}
            </P>
          ))}
        </Card>
      ) : null}

      <Card style={{ gap: 4 }}>
        <H2>Барилдааны түүх {bouts ? `(${fmtTokens(bouts.total)})` : ''}</H2>
        {!bouts ? <P muted small>Архивын түүх алга.</P> : null}
        {bouts?.rows.map((b, i) => (
          <View key={i} style={s.boutRow}>
            <Text style={[s.res, { color: b.won ? theme.success : theme.danger }]}>{b.won ? 'Д' : 'У'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.opp} onPress={() => onOpen(b.opponentId)}>
                {b.opponentName} <Text style={s.oppTitle}>{b.opponentTitleLabel}</Text>
                {b.noShow ? <Text style={s.oppTitle}> · гоц</Text> : null}
              </Text>
              <Text style={s.meta} numberOfLines={1}>
                {b.date} · {b.round}-р даваа · {b.tournamentName}
              </Text>
            </View>
          </View>
        ))}
        {bouts && bouts.rows.length < bouts.total ? (
          <Button small title={`Цааш (${fmtTokens(bouts.total - bouts.rows.length)} үлдсэн)`} variant="secondary" loading={loadingMore} onPress={() => void more()} />
        ) : null}
      </Card>
    </ScrollView>
  );
}

export function WrestlersScreen({ refreshKey }: { refreshKey: number }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<WrestlerDto[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  /** Профайлаас профайл руу орсон түүх — буцахад ашиглана. */
  const [stack, setStack] = useState<string[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ wrestlers: WrestlerDto[]; total: number }>(`/api/wrestlers?q=${encodeURIComponent(q.trim())}&limit=40`)
        .then((d) => {
          setList(d.wrestlers);
          setTotal(d.total);
        })
        .catch(() => setList([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, refreshKey]);

  if (selected) {
    return (
      <WrestlerProfile
        id={selected}
        onBack={() => {
          const prev = stack[stack.length - 1];
          if (prev) {
            setStack(stack.slice(0, -1));
            setSelected(prev);
          } else setSelected(null);
        }}
        onOpen={(id) => {
          setStack([...stack, selected]);
          setSelected(id);
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder={`Хайх (${fmtTokens(total || 22360)} бөх): нэр, цол, аймаг, сум…`}
        placeholderTextColor={theme.muted}
        style={s.search}
        autoCorrect={false}
      />
      <P muted small>Жишээ: «улсын заан ховд» · «сумъяа алтай» · «аймгийн арслан сүхбаатар». Бөх дээр дарж профайл, бүх барилдааны түүхийг үзнэ.</P>
      {list.map((w) => (
        <Card key={w.id} onPress={() => setSelected(w.id)} style={{ gap: 2, paddingVertical: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={s.rowName}>{w.name}</Text>
            <P muted small>{w.rating}</P>
          </Row>
          <P muted small>
            {w.titleLabel}
            {w.place ? ` · ${w.place}` : ''}
            {w.birthDate ? ` · ${w.birthDate.slice(0, 4)}` : ''}
          </P>
        </Card>
      ))}
      {!list.length && q.trim() ? (
        <Card>
          <P muted>Олдсонгүй.</P>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 10, paddingBottom: 40 },
  back: { color: theme.accent, fontWeight: '700' },
  search: { backgroundColor: theme.raised, color: theme.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, borderWidth: 1, borderColor: theme.border },
  name: { color: theme.text, fontSize: 19, fontWeight: '800' },
  rowName: { color: theme.text, fontSize: 15, fontWeight: '700' },
  boutRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: 'rgba(39,68,107,.45)' },
  res: { width: 18, textAlign: 'center', fontWeight: '900', fontSize: 14 },
  opp: { color: theme.accent, fontSize: 14, fontWeight: '700' },
  oppTitle: { color: theme.muted, fontSize: 12, fontWeight: '400' },
  meta: { color: theme.muted, fontSize: 12 },
});
