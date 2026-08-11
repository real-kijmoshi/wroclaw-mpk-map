import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass } from './glass';
import type { LiveStatus } from './map-sheet-home';
import { CHROME_MAX_SCALE, ThemedText } from './themed-text';
import { Elevation, HitTarget, Motion, Radius, Space } from '@/constants/design';
import { ACCENT, Colors } from '@/constants/theme';
import { useMapChrome } from '@/hooks/use-map-chrome';

/**
 * The classic layout's chrome.
 *
 * This is the arrangement the persistent sheet replaced: a status pill and a
 * search button across the top, a tower of round buttons down the right edge,
 * and a sheet that only exists while something is selected. It is offered as a
 * choice in Settings, and rebuilt here rather than restored verbatim — the
 * original hardcoded `theme.text` onto glass over the map, which is exactly the
 * combination that made the HUD unreadable on satellite and hybrid tiles. Every
 * surface below asks `useMapChrome()` what the map is drawing, the same as the
 * sheet layout's controls do.
 *
 * What else changed on the way back: the buttons are `HitTarget`-sized instead
 * of 46 and 40pt, the alerts button carries its count the way the lines button
 * always carried the filter's, and the status pill is a retry button when the
 * fleet poll is failing — in the original a dead connection was a grey dot and
 * nothing to press.
 */

/** Gap between the top bar and whatever the notch or status bar occupies. */
const TOP_GAP = Space.sm;

export type ClassicTopBarProps = {
  status: LiveStatus;
  /** How many lines the filter holds, for the clearable chip. */
  selectedLineCount: number;
  onClearFilter: () => void;
  onSearch: () => void;
  /** Pressing the pill while the fleet poll is failing. */
  onRetry: () => void;
  /** Why the last locate attempt produced nothing, if it produced nothing. */
  locateProblem: 'denied' | 'failed' | null;
  /** Pressing that note: the system settings, or another attempt. */
  onLocateProblem: () => void;
};

export function ClassicTopBar({
  status,
  selectedLineCount,
  onClearFilter,
  onSearch,
  onRetry,
  locateProblem,
  onLocateProblem,
}: ClassicTopBarProps) {
  const insets = useSafeAreaInsets();
  const { scheme, tokens } = useMapChrome();

  const offline = status.tone === 'error';
  // Keyed to the *chrome's* scheme, not the phone's: the light palette's green
  // is a dark one, and this dot can be sitting on the dark material because the
  // map underneath is satellite imagery.
  const dotColor =
    status.tone === 'live'
      ? Colors[scheme].success
      : offline
        ? Colors[scheme].danger
        : tokens.textSecondary;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.topBar, { paddingTop: insets.top + TOP_GAP }]}>
      <View pointerEvents="box-none" style={styles.topRow}>
        {/* One pill, two states: a live count, or a dead connection you can
            press. The freshness rides alongside the count rather than under it
            — the pill has to stay one line tall or it starts covering the map
            it is reporting on. */}
        <Pressable
          onPress={offline ? onRetry : undefined}
          disabled={!offline}
          accessibilityRole={offline ? 'button' : 'text'}
          accessibilityLabel={`${status.text}. ${status.freshness}`}
          accessibilityHint={offline ? 'Spróbuj połączyć ponownie' : undefined}
          style={({ pressed }) => [styles.pillPress, pressed && offline && styles.pressed]}>
          <Glass variant="chrome" scheme={scheme} style={styles.pill}>
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <ThemedText
              type="footnote"
              weight="semibold"
              color={tokens.text}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}
              style={styles.pillText}>
              {status.text}
            </ThemedText>
            <ThemedText
              type="footnote"
              color={tokens.textSecondary}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {offline ? 'Ponów' : status.freshness}
            </ThemedText>
          </Glass>
        </Pressable>

        {selectedLineCount > 0 && (
          <Pressable
            onPress={onClearFilter}
            accessibilityRole="button"
            accessibilityLabel={`Wyczyść filtr linii, wybrano ${selectedLineCount}`}
            style={({ pressed }) => [pressed && styles.pressed]}>
            <Glass variant="chrome" scheme={scheme} style={styles.chip}>
              <Ionicons name="funnel" size={13} color={tokens.text} />
              <ThemedText
                type="footnote"
                weight="semibold"
                color={tokens.text}
                maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                {selectedLineCount}
              </ThemedText>
              <Ionicons name="close" size={15} color={tokens.textSecondary} />
            </Glass>
          </Pressable>
        )}

        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Szukaj linii i przystanków"
          style={({ pressed }) => [styles.search, pressed && styles.pressed]}>
          <Glass variant="control" scheme={scheme} style={styles.round}>
            <Ionicons name="search" size={20} color={tokens.text} />
          </Glass>
        </Pressable>
      </View>

      {/*
       * The locate button's bad news.
       *
       * The sheet layout says this in its home list; this layout has no list, and
       * the original said it nowhere at all — the button simply did nothing and
       * the rider pressed it again. Denial and failure are different problems
       * with different answers, so the note says which one happened.
       */}
      {locateProblem && (
        <Pressable
          onPress={onLocateProblem}
          accessibilityRole="button"
          accessibilityLabel={
            locateProblem === 'denied'
              ? 'Brak dostępu do lokalizacji. Otwórz ustawienia systemu'
              : 'Nie udało się ustalić pozycji. Spróbuj ponownie'
          }
          style={({ pressed }) => [styles.notePress, pressed && styles.pressed]}>
          <Glass variant="chrome" scheme={scheme} style={styles.note}>
            <Ionicons name="locate" size={15} color={Colors[scheme].danger} />
            <ThemedText
              type="footnote"
              color={tokens.text}
              numberOfLines={2}
              maxFontSizeMultiplier={CHROME_MAX_SCALE}
              style={styles.noteText}>
              {locateProblem === 'denied'
                ? 'Brak dostępu do lokalizacji — włącz go w Ustawieniach'
                : 'Nie udało się ustalić pozycji — dotknij, aby spróbować'}
            </ThemedText>
          </Glass>
        </Pressable>
      )}
    </View>
  );
}

export type ClassicControl = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** A count worth seeing before the screen behind the button is opened. */
  badge?: number;
};

/**
 * The button tower.
 *
 * Separate circles rather than the sheet layout's single stack of glass: that
 * shape is the classic layout, and someone who chose it chose this.
 */
export function ClassicControls({ controls }: { controls: ClassicControl[] }) {
  return (
    <View style={styles.tower}>
      {controls.map((control) => (
        <RoundButton key={control.label} {...control} />
      ))}
    </View>
  );
}

function RoundButton({ icon, label, onPress, disabled, badge }: ClassicControl) {
  const { scheme, tokens } = useMapChrome();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge}` : label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.roundPress,
        pressed && !disabled && styles.pressed,
        disabled && styles.pressed,
      ]}>
      <View style={styles.roundWrap}>
        <Glass variant="control" scheme={scheme} style={styles.round}>
          <Ionicons name={icon} size={20} color={tokens.text} />
        </Glass>
        {badge !== undefined && badge > 0 && (
          /*
           * Outside the Glass on purpose: it clips to its own rounded shape,
           * which cut the badge off where it pokes past the button's edge.
           *
           * The light accent in both schemes, deliberately. A badge is a solid
           * patch of colour, so what has to clear 4.5:1 is the white numeral on
           * it — and the dark accent is a *light* blue that white sits on at
           * 2.3:1. It is legible against either material behind it.
           */
          <View style={[styles.badge, { backgroundColor: ACCENT.light }]}>
            <ThemedText
              type="caption"
              weight="bold"
              color="#ffffff"
              allowFontScaling={false}
              style={styles.badgeText}>
              {badge > 99 ? '99+' : badge}
            </ThemedText>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Space.md,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  pillPress: { flexShrink: 1, minWidth: 0, borderRadius: Radius.pill },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 36,
    paddingHorizontal: Space.md,
    borderRadius: Radius.pill,
    ...Elevation.floating,
  },
  pillText: { flexShrink: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: Radius.pill },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    minHeight: 36,
    paddingHorizontal: Space.md,
    borderRadius: Radius.pill,
    ...Elevation.floating,
  },
  // Pushed to the far edge whatever else is in the row, so it never moves as
  // the count beside it grows or the filter chip appears.
  search: { marginLeft: 'auto' },
  notePress: { marginTop: Space.sm, borderRadius: Radius.lg },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 40,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderRadius: Radius.lg,
    ...Elevation.floating,
  },
  noteText: { flex: 1, minWidth: 0 },
  tower: { alignItems: 'flex-end', gap: Space.sm },
  roundPress: { borderRadius: Radius.pill },
  roundWrap: { width: HitTarget, height: HitTarget },
  round: {
    width: HitTarget,
    height: HitTarget,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    ...Elevation.floating,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: Radius.pill,
    paddingHorizontal: Space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { lineHeight: 14 },
  pressed: { opacity: Motion.pressedOpacity },
});
