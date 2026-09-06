import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, saveToken } from '../api';
import { Button, Card, Field, H1, Msg, P } from '../components/ui';
import type { MeDto } from '../shared/api';
import { theme } from '../theme';

type Mode = 'login' | 'register' | 'forgot' | 'reset';

export function AuthScreen({ onAuthed }: { onAuthed: (me: MeDto) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [referrer, setReferrer] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Алдаа гарлаа.');
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      if (mode === 'login') {
        const r = await api<{ me: MeDto; token: string }>('/api/login', { body: { username, password } });
        await saveToken(r.token);
        onAuthed(r.me);
      } else if (mode === 'register') {
        const r = await api<{ me: MeDto; token: string; codeSent: boolean }>('/api/register', { body: { username, password, email, referrer: referrer.trim() || undefined } });
        await saveToken(r.token);
        onAuthed(r.me);
      } else if (mode === 'forgot') {
        await api('/api/forgot', { body: { email } });
        setInfo('Хэрэв энэ имэйл бүртгэлтэй бол сэргээх код илгээгдлээ. Имэйлээ (Spam хавтас ч) шалгана уу.');
        setMode('reset');
      } else {
        await api('/api/reset', { body: { email, code, password } });
        setInfo('Нууц үг шинэчлэгдлээ. Одоо нэвтэрнэ үү.');
        setMode('login');
      }
    });

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <View style={s.brand}>
        <Text style={s.logo}>🤼</Text>
        <H1>Бөхийн таавар</H1>
        <P muted>Найз нөхдийн хүрээний виртуал токены таамаглалын зах зээл</P>
      </View>

      <Card style={{ gap: 12 }}>
        <View style={s.tabs}>
          {(['login', 'register'] as const).map((m) => (
            <Text key={m} onPress={() => setMode(m)} style={[s.tab, (mode === m || (m === 'login' && (mode === 'forgot' || mode === 'reset'))) && s.tabActive]}>
              {m === 'login' ? 'Нэвтрэх' : 'Бүртгүүлэх'}
            </Text>
          ))}
        </View>

        {mode === 'login' || mode === 'register' ? (
          <>
            <Field label="Нэр" value={username} onChangeText={setUsername} placeholder="Хэрэглэгчийн нэр" autoCapitalize="words" onSubmit={submit} />
            {mode === 'register' ? <Field label="Имэйл" value={email} onChangeText={setEmail} placeholder="нэр@жишээ.mn" keyboard="email-address" onSubmit={submit} /> : null}
            <Field label="Нууц үг" value={password} onChangeText={setPassword} placeholder="дор хаяж 6 тэмдэгт" secure onSubmit={submit} />
            {mode === 'register' ? <Field label="Хэн урьсан бэ? (заавал биш — хоёуланд +1 000)" value={referrer} onChangeText={setReferrer} placeholder="найзын хэрэглэгчийн нэр" autoCapitalize="words" onSubmit={submit} /> : null}
          </>
        ) : mode === 'forgot' ? (
          <Field label="Бүртгэлтэй имэйл" value={email} onChangeText={setEmail} placeholder="нэр@жишээ.mn" keyboard="email-address" onSubmit={submit} />
        ) : (
          <>
            <Field label="Имэйл" value={email} onChangeText={setEmail} keyboard="email-address" />
            <Field label="Имэйлээр ирсэн 6 оронтой код" value={code} onChangeText={setCode} keyboard="number-pad" />
            <Field label="Шинэ нууц үг" value={password} onChangeText={setPassword} secure onSubmit={submit} />
          </>
        )}

        <Msg text={error} />
        <Msg text={info} kind="ok" />

        <Button
          title={mode === 'login' ? 'Нэвтрэх' : mode === 'register' ? 'Бүртгүүлэх' : mode === 'forgot' ? 'Код авах' : 'Нууц үг шинэчлэх'}
          onPress={submit}
          loading={busy}
          variant="accent"
        />

        {mode === 'login' ? (
          <Text style={s.link} onPress={() => setMode('forgot')}>
            Нууц үгээ мартсан?
          </Text>
        ) : mode === 'forgot' || mode === 'reset' ? (
          <Text style={s.link} onPress={() => setMode('login')}>
            ← Нэвтрэх рүү буцах
          </Text>
        ) : null}
      </Card>

      <P muted small style={{ textAlign: 'center' }}>
        Токен нь виртуал оноо — бодит мөнгө биш, худалдаж авах, бэлэн болгох боломжгүй.
      </P>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 20, gap: 20, maxWidth: 480, width: '100%', alignSelf: 'center', flexGrow: 1, justifyContent: 'center' },
  brand: { alignItems: 'center', gap: 6 },
  logo: { fontSize: 44 },
  tabs: { flexDirection: 'row', backgroundColor: theme.raised, borderRadius: 10, padding: 4 },
  tab: { flex: 1, textAlign: 'center', paddingVertical: 8, color: theme.muted, fontWeight: '700', borderRadius: 8 },
  tabActive: { backgroundColor: theme.surface, color: theme.text },
  link: { color: theme.accent, textAlign: 'center', paddingVertical: 4 },
});
