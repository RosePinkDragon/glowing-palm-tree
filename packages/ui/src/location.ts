import * as Location from 'expo-location';
import { validateLocationFix } from '@market/core';

export async function requestLocation() {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Location permission is needed to check delivery. Please allow location access and try again.');
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return validateLocationFix({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy ?? Infinity, capturedAtISO: new Date(position.timestamp).toISOString() });
}
