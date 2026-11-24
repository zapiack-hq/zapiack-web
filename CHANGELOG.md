# Changelog

All notable changes to @zapiack/web are listed here. Versions follow [semantic versioning](https://semver.org).

## 0.2.0

- Voice & Video: `ZapiackCall` (`@zapiack/web/calls`) joins a room and sends and receives audio, video and screen share, with mute, stats and automatic rejoin. Needs the optional peer `mediasoup-client`.
- Realtime: `request()` asks a Zapiack service something over the connection and waits for the answer; it fails at once when the line is down.
- Realtime: `ZapiackRealtime` for live messages over one WebSocket: channels, presence, signals, resume after a dropped connection.

## 0.1.1

Adds the repository and issue links to the package page. No code changes.

## 0.1.0

First release.

Web push in the browser: registers each visitor, shows pictures and buttons, reports arrivals and taps, and follows what people do next.
