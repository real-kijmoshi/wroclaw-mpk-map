const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-maps') {
    return { filePath: path.join(__dirname, '.preview', 'maps-stub.js'), type: 'sourceFile' };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
