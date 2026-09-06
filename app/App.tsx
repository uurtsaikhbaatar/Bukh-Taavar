import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, loadToken, saveToken, subscribe } from './src/api';
import { Loading } from './src/components/ui';
import { fmtTokens } from './src/format';
import { AdminScreen } from './src/screens/AdminScreen';
import { ArchiveScreen } from './src/screens/ArchiveScreen';
import { AuthScreen } from './src/screens/AuthScreen';
import { BoardScreen } from './src/screens/BoardScreen';
import { CouponScreen, type SlipItem } from './src/screens/CouponScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { MarketScreen } from './src/screens/MarketScreen';
import { LeaderboardScreen, PortfolioScreen } from './src/screens/PortfolioScreen';
import { TotoScreen } from './src/screens/TotoScreen';
import { WrestlersScreen } from './src/screens/WrestlersScreen';
import type { MeDto } from './src/shared/api';
import { theme } from './src/theme';

type Tab = 'home' | 'toto' | 'wrestlers' | 'portfolio' | 'leaderboard' | 'admin';

export default function App() {
  const [me, setMe] = useState<MeDto | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>('home');
  const [marketId, setMarketId] = useState<string | null>(null);
  /** Нээлттэй бооцооны самбар (тэмцээний id) — зах зээлээс буцахад энд ирнэ. */
  const [boardId, setBoardId] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [online, setOnline] = useState(true);
  const [slip, setSlip] = useState<SlipItem[]>([]);
  const [showCoupon, setShowCoupon] = useState(false);

  const addToSlip = (item: SlipItem) =>
    setSlip((prev) => {
      const rest = prev.filter((x) => x.marketId !== item.marketId);
      // Ижил зах зээлийн ижил сонголт дахин дарвал хасна
      const same = prev.find((x) => x.marketId === item.marketId && x.outcome === item.outcome);
      return same ? rest : [...rest, item];
    });

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<MeDto>('/api/me'));
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        await saveToken(null);
      } else if (e instanceof ApiError && e.status === 0) setOnline(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadToken();
      await refreshMe();
      setBooting(false);
    })();
  }, [refreshMe]);

  // Серверийн «өөрчлөгдлөө» → бүх дэлгэц дахин татна
  useEffect(() => {
    if (!me) return;
    const stop = subscribe(() => {
      setRefreshKey((k) => k + 1);
      void refreshMe();
    });
    return stop;
  }, [me?.account.id, refreshMe]);

  if (booting) {
    return (
      <View style={s.center}>
        <StatusBar style="light" />
        <Loading text="Бөхийн таавар…" />
      </View>
    );
  }
  if (!me) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <AuthScreen onAuthed={(m) => {
          setMe(m);
          setTab('home');
        }} />
      </SafeAreaView>
    );
  }

  const openMarket = (id: string) => {
    setShowCoupon(false);
    setMarketId(id);
  };
  const body = showCoupon ? (
    <CouponScreen
      slip={slip}
      me={me}
      onRemove={(id) => setSlip((prev) => prev.filter((x) => x.marketId !== id))}
      onClear={() => setSlip([])}
      onBack={() => setShowCoupon(false)}
      onPlaced={(balance) => setMe((m) => (m ? { ...m, balance } : m))}
    />
  ) : marketId ? (
    <MarketScreen
      marketId={marketId}
      me={me}
      refreshKey={refreshKey}
      slip={slip}
      onAddToSlip={addToSlip}
      onBack={() => setMarketId(null)}
      onTraded={(balance) => setMe((m) => (m ? { ...m, balance } : m))}
    />
  ) : showArchive ? (
    <ArchiveScreen onBack={() => setShowArchive(false)} onOpenBoard={(id) => { setShowArchive(false); setBoardId(id); }} />
  ) : boardId ? (
    <BoardScreen
      tournamentId={boardId}
      me={me}
      refreshKey={refreshKey}
      onBack={() => setBoardId(null)}
      onOpenMarket={openMarket}
      onTraded={(balance) => setMe((m) => (m ? { ...m, balance } : m))}
    />
  ) : tab === 'home' ? (
    <HomeScreen refreshKey={refreshKey} onOpenMarket={openMarket} onOpenBoard={(id) => setBoardId(id)} onOpenArchive={() => setShowArchive(true)} />
  ) : tab === 'toto' ? (
    <TotoScreen me={me} refreshKey={refreshKey} onTraded={(balance) => setMe((m) => (m ? { ...m, balance } : m))} />
  ) : tab === 'wrestlers' ? (
    <WrestlersScreen refreshKey={refreshKey} />
  ) : tab === 'portfolio' ? (
    <PortfolioScreen me={me} refreshKey={refreshKey} onOpenMarket={openMarket} onMe={setMe} onLogout={() => setMe(null)} />
  ) : tab === 'leaderboard' ? (
    <LeaderboardScreen refreshKey={refreshKey} />
  ) : (
    <AdminScreen refreshKey={refreshKey} onOpenMarket={openMarket} />
  );

  const tabs: [Tab, string][] = [
    ['home', '🥋 Барилдаанууд'],
    ['toto', '🎟 Багц таавар'],
    ['wrestlers', '🤼 Бөхчүүд'],
    ['portfolio', '👤 Би'],
    ['leaderboard', '🏆 Самбар'],
  ];
  if (me.account.role === 'admin') tabs.push(['admin', '⚙️ Админ']);

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <View style={s.brandRow}>
          <Image source={require('./assets/chogsom-bukh.jpg')} style={s.brandLogo} resizeMode="cover" accessibilityLabel="Б.Чогсом, «Бөх», 1972" />
          <Text style={s.brand}>Бөхийн таавар</Text>
        </View>
        <Text style={s.balance}>{fmtTokens(me.balance)} ₮оken</Text>
      </View>
      {!online ? <Text style={s.offline}>Сервертэй холбогдож чадахгүй байна…</Text> : null}
      <View style={s.content}>{body}</View>
      {slip.length > 0 && !showCoupon ? (
        <Pressable onPress={() => setShowCoupon(true)} style={s.slipBar} accessibilityRole="button">
          <Text style={s.slipText}>🧾 Купон: {slip.length} сонголт — нээх</Text>
          <Text style={s.slipCoef}>×{slip.reduce((c, l) => c * (1 / l.price), 1).toFixed(2)}</Text>
        </Pressable>
      ) : null}
      <View style={s.tabbar}>
        {tabs.map(([k, label]) => (
          <Pressable
            key={k}
            onPress={() => {
              setMarketId(null);
              setBoardId(null);
              setShowArchive(false);
              setShowCoupon(false);
              setTab(k);
              setRefreshKey((x) => x + 1);
            }}
            style={s.tabBtn}
            accessibilityRole="button"
          >
            <Text style={[s.tabLabel, tab === k && !marketId && !boardId && s.tabActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: theme.surface, borderBottomWidth: 1, borderBottomColor: theme.border },
  brand: { color: theme.text, fontSize: 17, fontWeight: '800' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  brandLogo: { height: 26, width: 74, borderRadius: 6, borderWidth: 1, borderColor: theme.border },
  balance: { color: theme.accent, fontSize: 16, fontWeight: '800' },
  offline: { color: theme.danger, textAlign: 'center', padding: 4, backgroundColor: theme.surface },
  content: { flex: 1, maxWidth: 720, width: '100%', alignSelf: 'center' },
  tabbar: { flexDirection: 'row', backgroundColor: theme.surface, borderTopWidth: 1, borderTopColor: theme.border, paddingBottom: Platform.OS === 'web' ? 6 : 0 },
  slipBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: theme.accent, paddingHorizontal: 16, paddingVertical: 10, maxWidth: 720, width: '100%', alignSelf: 'center' },
  slipText: { color: theme.accentText, fontWeight: '800', fontSize: 15 },
  slipCoef: { color: theme.accentText, fontWeight: '800', fontSize: 15 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabLabel: { color: theme.muted, fontWeight: '700', fontSize: 13 },
  tabActive: { color: theme.accent },
});
