import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import SwipeableModal from "../components/Modal";

export default function AlertsModal({ visible, onClose, alerts = [], loading, error }) {
  return (
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Alerty</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityLabel="Close alerts modal">
          <Text style={styles.closeButtonText}>Zamknij</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {loading && <ActivityIndicator size="large" color="#0A84FF" style={{ marginTop: 20 }} />}

        {error && (
          <Text style={[styles.alertText, styles.errorText]}>
            {error}
          </Text>
        )}

        {!loading && !error && alerts.length === 0 && (
          <Text style={styles.emptyText}>Brak alertów.</Text>
        )}

        {!loading && !error && alerts.length > 0 && (
          alerts.map((alert, idx) => (
            <View key={idx} style={styles.alertContainer}>
              <Text style={styles.alertText}>{alert.content}</Text>
              <Text style={styles.timestampText}>
                {new Date(alert.timestamp).toLocaleString()}
              </Text>
              <Text style={styles.affectedLinesText}>
                Affected Lines: {alert.affected.join(", ")}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </SwipeableModal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#444",
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#fff",
  },
  closeButton: {
    padding: 8,
  },
  closeButtonText: {
    fontSize: 17,
    color: "#0A84FF",
    fontWeight: "600",
  },
  scrollContent: {
    paddingBottom: 30,
    backgroundColor: "#121212",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  alertContainer: {
    paddingVertical: 12,
    borderBottomColor: "#333",
    borderBottomWidth: 1,
  },
  alertText: {
    fontSize: 16,
    color: "#E0E0E0",
    marginBottom: 4,
  },
  timestampText: {
    fontSize: 12,
    color: "#888",
    marginBottom: 2,
  },
  affectedLinesText: {
    fontSize: 12,
    color: "#888",
  },
  errorText: {
    color: "#FF3B30",
    marginTop: 20,
    fontWeight: "600",
  },
  emptyText: {
    fontSize: 16,
    color: "#AAA",
    marginTop: 20,
    fontStyle: "italic",
  },
});