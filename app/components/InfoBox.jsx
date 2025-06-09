import { StyleSheet, Text } from "react-native"
import { useEffect, useState } from "react"

export default function InfoBox({ lastUpdated }) {
    const [time, setTime] = useState(new Date().toLocaleTimeString());

    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString());
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    return (
        <Text Text style={styles.infoText}>
          {`Aktualizajca: ${new Date(lastUpdated).toLocaleTimeString()}`}
          {"\n"}
          {`Godzina: ${time}`}
        </Text>
    )
}

const styles = StyleSheet.create({
  infoText: {
      position: "absolute",
      top: 50,
      left: 20,
      color: "#333",
      fontSize: 14,
      fontWeight: "500",
      backgroundColor: "rgba(0, 128, 255, 0.8)",
      color: "#fff",
      padding: 8,
      borderRadius: 8,
      zIndex: 1,
  },
});
