import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.stgeorge.zaitoun.dashboard',
  appName: 'St. George Dashboard',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#030711'
  }
};

export default config;
