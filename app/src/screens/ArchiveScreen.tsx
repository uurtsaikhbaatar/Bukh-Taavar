/**
 * Өмнөх тэмцээнүүд (архив) — devjee-ийн бүх түүх: 1900 оноос хойших тэмцээн бүрийн
 * бүх барилдааны үр дүнг даваа даваагаар үзнэ. Зөвхөн унших (бооцоо байхгүй).
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, ApiError } from '../api';
import { Button, Card, H2, Loading, Msg, P, Row } from '../components/ui';
import { fmtTokens } from '../format';
import type { ArchiveTournamentDetailDto, ArchiveTournamentsDto } from '../shared/api';
import { theme } from '../theme';

const YEARS = ['Бүгд', '2026', '2025', '2024', '2023', '2022', '2021', '2020'];

function ArchiveTournamentView({ tid, onBack, onOpenBoard }: { tid: string; onBack: () => void; onOpenBoard?: (appId: string) => void }) {
  const [data, setData] = useState<ArchiveTournamentDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRound, setOpenRound] = useState<number | null>(null);

  useEffect(() => {
    api<ArchiveTournamentDetailDto>(`/api/archive/tournaments/${encodeURIComponent(tid)}`)
      .then((d) => {
        setData(d);
        // Сүүлийн (финалын) даваанаас нээлттэй эхэлнэ
        setOpenRound(d.bouts.length ? Math.max(...d.bouts.map((b) => b.round)) : null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
  }, [tid]);

  if (!data && !error) return <Loading />;
  if (!data) return <Msg text={error} />;
  const t = data.tournament;
  const byRound = new Map<number, ArchiveTournamentDetailDto['bouts']>();
  for (const b of data.bouts) byRound.set(b.round, [...(byRound.get(b.round) ?? []), b]);
  const rounds = [...byRound.keys()].sort((a, b) => b - a);

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.back} onPress={onBack}>← Өмнөх тэмцээнүүд</Text>
      <Card style={{ gap: 4 }}>
        <Text style={s.title}>{t.name}</Text>
        <P muted small>
          {t.date}
          {t.place ? ` · ${t.place}` : ''} · {t.rounds} даваа · {fmtTokens(t.wrestlerCount)} бөх · {fmtTokens(t.matchCount)} барилдаан
        </P>
      </Card>
      {rounds.map((r) => {
        const list = byRound.get(r)!;
        const open = openRound === r;
        return (
          <Card key={r} style={{ gap: 4 }}>
            <Pressable onPress={() => setOpenRound(open ? null : r)} accessibilityRole="button">
              <H2>
                {open ? '▾' : '▸'} {r}-р даваа · {list.length} барилдаан
              </H2>
            </Pressable>
            {open
              ? list.map((b, i) => (
                  <View key={i} style={s.boutRow}>
                    <Text style={[s.side, { textAlign: 'right' }, b.winner === 1 && s.won]} numberOfLines={1}>
                      {b.w1Name} <Text style={s.tl}>{b.w1TitleLabel}</Text>
                    </Text>
                    <Text style={s.mid}>{b.winner === 1 ? '◀' : '▶'}</Text>
                    <Text style={[s.side, b.winner === 2 && s.won]} numberOfLines={1}>
                      <Text style={s.tl}>{b.w2TitleLabel}</Text> {b.w2Name}
                    </Text>
                    {b.noShow ? <Text style={s.noshow}>гоц</Text> : null}
                  </View>
                ))
              : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}

export function ArchiveScreen({ onBack, onOpenBoard }: { onBack: () => void; onOpenBoard?: (appId: string) => void }) {
  const [q, setQ] = useState('');
  const [year, setYear] = useState('Бүгд');
  const [data, setData] = useState<ArchiveTournamentsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const query = (offset: number) =>
    api<ArchiveTournamentsDto>(`/api/archive/tournaments?q=${encodeURIComponent(q.trim())}&year=${year === 'Бүгд' ? '' : year}&offset=${offset}&limit=30`);

  useEffect(() => {
    const t = setTimeout(() => {
      query(0)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Алдаа'));
    }, 250);
    return () => clearTimeout(t);
  }, [q, year]);

  if (selected) return <ArchiveTournamentView tid={selected} onBack={() => setSelected(null)} {...(onOpenBoard ? { onOpenBoard } : {})} />;

  const more = async () => {
    if (!data) return;
    setLoadingMore(true);
    try {
      const next = await query(data.rows.length);
      setData({ ...next, rows: [...data.rows, ...next.rows] });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <Text style={s.back} onPress={onBack}>← Барилдаанууд</Text>
      <H2>Өмнөх тэмцээнүүд — бүх түүх{data ? ` (${fmtTokens(data.total)})` : ''}</H2>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Тэмцээний нэр, аймгаар хайх…"
        placeholderTextColor={theme.muted}
        style={s.search}
        autoCorrect={false}
      />
      <Row gap={6}>
        {YEARS.map((y) => (
          <Pressable key={y} onPress={() => setYear(y)} style={[s.chip, year === y && s.chipOn]} accessibilityRole="button">
            <Text style={[s.chipText, year === y && { color: theme.accentText }]}>{y}</Text>
          </Pressable>
        ))}
      </Row>
      <Msg text={error} />
      {!data && !error ? <Loading /> : null}
      {data?.rows.map((t) => (
        <Card key={t.id} onPress={() => setSelected(t.id)} style={{ gap: 2, paddingVertical: 10 }}>
          <Text style={s.rowName} numberOfLines={2}>{t.name}</Text>
          <P muted small>
            {t.date}
            {t.place ? ` · ${t.place}` : ''} · {t.rounds} даваа · {fmtTokens(t.wrestlerCount)} бөх · {fmtTokens(t.matchCount)} барилдаан
          </P>
        </Card>
      ))}
      {data && data.rows.length < data.total ? (
        <Button small title={`Цааш (${fmtTokens(data.total - data.rows.length)} үлдсэн)`} variant="secondary" loading={loadingMore} onPress={() => void more()} />
      ) : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 14, gap: 10, paddingBottom: 40 },
  back: { color: theme.accent, fontWeight: '700' },
  title: { color: theme.text, fontSize: 16, fontWeight: '800' },
  rowName: { color: theme.text, fontSize: 14.5, fontWeight: '700' },
  search: { backgroundColor: theme.raised, color: theme.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, borderWidth: 1, borderColor: theme.border },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.raised, borderWidth: 1, borderColor: theme.border },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.text, fontWeight: '700', fontSize: 13 },
  boutRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: 'rgba(39,68,107,.45)' },
  side: { flex: 1, color: theme.muted, fontSize: 13 },
  won: { color: theme.text, fontWeight: '800' },
  mid: { color: theme.accent, fontSize: 12, fontWeight: '900' },
  tl: { color: theme.muted, fontSize: 11, fontWeight: '400' },
  noshow: { color: theme.muted, fontSize: 11 },
});
