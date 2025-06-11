import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from "react-native";
import SwipeableModal from "../components/Modal";

export default function AlertsModal({ visible, onClose, alerts = [], loading, error }) {
  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMinutes = Math.floor((now - date) / (1000 * 60));
    
    if (diffInMinutes < 1) return 'teraz';
    if (diffInMinutes < 60) return `${diffInMinutes}m`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`;
    return `${Math.floor(diffInMinutes / 1440)}d`;
  };

  return (
    <SwipeableModal visible={visible} onClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Powiadomienia</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
        >
          {loading && (
            <View style={styles.centerContainer}>
              <ActivityIndicator size="large" color="#666" />
            </View>
          )}

          {error && (
            <View style={styles.centerContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {!loading && !error && alerts.length === 0 && (
            <View style={styles.centerContainer}>
              <Text style={styles.emptyText}>Brak powiadomień</Text>
            </View>
          )}

          {!loading && !error && alerts.length > 0 && (
            alerts.map((alert, idx) => (
              <TouchableOpacity
                onPress={() => {
                  if (alert.url) {
                    Linking.openURL(alert.url).catch(err => console.error('Failed to open URL:', err));
                  }
                }} 
                key={idx} 
                style={styles.notification}
                
                >
                
                <View style={styles.notificationHeader}>
                  <Text style={styles.senderName}>MPK Wrocław</Text>
                  <Text style={styles.handle}>@AlertMPK</Text>
                  <Text style={styles.time}>· {formatTime(alert.timestamp)}</Text>
                </View>
                
                <View style={styles.notificationContent}>
                  {alert.content.includes('#AlertMPK') && (
                    <Text style={styles.hashtagText}>#AlertMPK </Text>
                  )}
                  {alert.content.includes('#TRAM') && (
                    <Text style={styles.hashtagText}>#TRAM{'\n'}</Text>
                  )}
                  {alert.priority === 'high' && <Text style={styles.warningIcon}>⚠️ </Text>}
                  {alert.type === 'tram' && <Text style={styles.tramIcon}>🚋 </Text>}
                  {alert.type === 'bus' && <Text style={styles.busIcon}>🚌 </Text>}
                  <Text style={styles.notificationText}>
                    {alert.content.replace(/#AlertMPK|#TRAM/g, '').trim()}
                  </Text>
                </View>

                {alert.affected && alert.affected.length > 0 && (
                  <Text style={styles.affectedLines}>
                    Linie: {alert.affected.join(', ')}
                  </Text>
                )}
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </View>
    </SwipeableModal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
  },
  closeButton: {
    padding: 4,
  },
  closeButtonText: {
    fontSize: 18,
    color: "#8E8E93",
    fontWeight: "400",
  },
  scrollView: {
    flex: 1,
  },
  centerContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
  },
  notification: {
    backgroundColor: '#1C1C1E',
    marginHorizontal: 8,
    marginBottom: 8,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  notificationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  senderName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    marginRight: 4,
  },
  handle: {
    fontSize: 15,
    color: '#8E8E93',
    marginRight: 4,
    fontWeight: '400',
  },
  time: {
    fontSize: 15,
    color: '#8E8E93',
    fontWeight: '400',
  },
  notificationContent: {
    marginTop: 2,
  },
  hashtagText: {
    fontSize: 15,
    color: '#0A84FF',
    fontWeight: '400',
  },
  warningIcon: {
    fontSize: 15,
  },
  tramIcon: {
    fontSize: 15,
  },
  busIcon: {
    fontSize: 15,
  },
  notificationText: {
    fontSize: 15,
    color: '#fff',
    lineHeight: 20,
    fontWeight: '400',
  },
  affectedLines: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 6,
    fontWeight: '400',
  },
  errorText: {
    fontSize: 16,
    color: '#ff3b30',
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
});