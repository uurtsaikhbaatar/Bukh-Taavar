import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { theme } from '../theme';
import { fmtPct } from '../format';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  small,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      style={({ pressed }) => [s.btn, small && s.btnSmall, variants[variant], pressed && !inactive && { opacity: 0.8 }, inactive && { opacity: 0.45 }, style]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'accent' ? theme.accentText : theme.text} />
      ) : (
        <Text style={[s.btnLabel, small && { fontSize: 14 }, variant === 'accent' && { color: theme.accentText }, variant === 'ghost' && { color: theme.muted }]}>{title}</Text>
      )}
    </Pressable>
  );
}

const variants: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: theme.primary },
  accent: { backgroundColor: theme.accent },
  secondary: { backgroundColor: theme.raised },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: theme.danger },
};

export function Card({ children, style, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }, style]} accessibilityRole="button">
        {children}
      </Pressable>
    );
  }
  return <View style={[s.card, style]}>{children}</View>;
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboard,
  autoCapitalize = 'none',
  onSubmit,
  style,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboard?: 'default' | 'numeric' | 'email-address' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  onSubmit?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[s.field, style]}>
      {label ? <Text style={s.label}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        secureTextEntry={secure}
        keyboardType={keyboard ?? 'default'}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        onSubmitEditing={onSubmit}
        style={s.input}
      />
    </View>
  );
}

export function H1({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.h1, style]}>{children}</Text>;
}

export function H2({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.h2, style]}>{children}</Text>;
}

export function P({ children, muted, style, small }: { children: React.ReactNode; muted?: boolean; style?: StyleProp<TextStyle>; small?: boolean }) {
  return <Text style={[s.p, muted && { color: theme.muted }, small && { fontSize: 13 }, style]}>{children}</Text>;
}

export function Msg({ text, kind = 'error' }: { text: string | null | undefined; kind?: 'error' | 'ok' | 'info' }) {
  if (!text) return null;
  const color = kind === 'error' ? theme.danger : kind === 'ok' ? theme.success : theme.warn;
  return (
    <View style={[s.msg, { borderColor: color }]}>
      <Text style={{ color, fontSize: 14 }}>{text}</Text>
    </View>
  );
}

export function Loading({ text = 'Уншиж байна…' }: { text?: string }) {
  return (
    <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
      <ActivityIndicator color={theme.accent} />
      <Text style={{ color: theme.muted }}>{text}</Text>
    </View>
  );
}

export function Pill({ text, color = theme.raised, textColor = theme.text }: { text: string; color?: string; textColor?: string }) {
  return (
    <View style={[s.pill, { backgroundColor: color }]}>
      <Text style={{ color: textColor, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

/** Үр дүнгийн магадлалын зурвас: зах зээл (тод) + загвар (тэмдэг). */
export function ProbBar({ label, sub, prob, model, highlight, onPress, right }: { label: string; sub?: string; prob: number; model?: number; highlight?: boolean; onPress?: () => void; right?: string }) {
  const inner = (
    <View style={s.probRow}>
      <View style={s.probHead}>
        <View style={{ flexShrink: 1 }}>
          <Text style={[s.probLabel, highlight && { color: theme.accent }]} numberOfLines={1}>
            {label}
          </Text>
          {sub ? (
            <Text style={s.probSub} numberOfLines={2}>
              {sub}
            </Text>
          ) : null}
        </View>
        <Text style={s.probPct}>
          {fmtPct(prob)}
          {right ? <Text style={{ color: theme.muted, fontWeight: '400' }}> · {right}</Text> : null}
        </Text>
      </View>
      <View style={s.track}>
        <View style={[s.fill, { width: `${Math.max(1, Math.round(prob * 100))}%` as unknown as number, backgroundColor: highlight ? theme.accent : theme.primary }]} />
        {model !== undefined ? <View style={[s.marker, { left: `${Math.round(model * 100)}%` as unknown as number }]} /> : null}
      </View>
    </View>
  );
  if (onPress) return <Pressable onPress={onPress}>{inner}</Pressable>;
  return inner;
}

export function Row({ children, style, gap = 8 }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function KV({ k, v, vColor }: { k: string; v: string; vColor?: string }) {
  return (
    <View style={s.kv}>
      <Text style={{ color: theme.muted, fontSize: 13 }}>{k}</Text>
      <Text style={{ color: vColor ?? theme.text, fontSize: 15, fontWeight: '700' }}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  btn: { minHeight: 46, paddingHorizontal: 18, borderRadius: theme.radius, alignItems: 'center', justifyContent: 'center' },
  btnSmall: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10 },
  btnLabel: { color: theme.text, fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: theme.surface, borderRadius: theme.radius, padding: 14, gap: 8, borderWidth: 1, borderColor: theme.border },
  field: { gap: 6 },
  label: { color: theme.muted, fontSize: 13 },
  input: { backgroundColor: theme.raised, color: theme.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, borderWidth: 1, borderColor: theme.border },
  h1: { color: theme.text, fontSize: 24, fontWeight: '800' },
  h2: { color: theme.text, fontSize: 18, fontWeight: '700' },
  p: { color: theme.text, fontSize: 15, lineHeight: 21 },
  msg: { borderWidth: 1, borderRadius: 10, padding: 10, backgroundColor: 'rgba(0,0,0,0.2)' },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  probRow: { gap: 4, paddingVertical: 4 },
  probHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  probLabel: { color: theme.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  probSub: { color: theme.muted, fontSize: 12, marginTop: 1 },
  probPct: { color: theme.text, fontSize: 15, fontWeight: '800' },
  track: { height: 10, backgroundColor: theme.raised, borderRadius: 6, overflow: 'hidden', position: 'relative' },
  fill: { height: '100%', borderRadius: 6 },
  marker: { position: 'absolute', top: 0, width: 2, height: '100%', backgroundColor: theme.text, opacity: 0.8 },
  kv: { gap: 2, minWidth: 90 },
});
