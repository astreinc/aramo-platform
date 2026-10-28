# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# @generated begin expo-build-properties - expo prebuild (DO NOT MODIFY)

# react-native-pdf: the PdfiumAndroid renderer (JNI) and the viewer it drives.
-keep class io.legere.pdfiumandroid.** { *; }
-keep class com.shockwave.pdfium.** { *; }
-keep class com.github.barteksc.pdfviewer.** { *; }
-keep class org.wonday.pdf.** { *; }
# react-native-blob-util (file writes / downloads used by the renderer and share sheet).
-keep class com.ReactNativeBlobUtil.** { *; }
-dontwarn com.ReactNativeBlobUtil.**
# Hermes and React Native native bridges reached from C++.
-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.facebook.react.bridge.** { *; }
# Expo modules are looked up by name at runtime.
-keep class expo.modules.** { *; }
-keep class * extends expo.modules.kotlin.modules.Module { *; }
# ML Kit document scanner (Play services) and the scanner plugin.
-keep class com.google.mlkit.vision.documentscanner.** { *; }
-keep class com.documentscanner.** { *; }
-dontwarn com.google.mlkit.**

# @generated end expo-build-properties