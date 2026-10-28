plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val novaAbi = providers.gradleProperty("novaAbi").orElse("arm64-v8a")

android {
    namespace = "com.jarvis.app"
    compileSdk = 34

    defaultConfig {
        // Kept for in-place upgrades from Jarvis. The public product name is Nova.
        applicationId = "com.jarvis.app"
        minSdk = 28
        targetSdk = 34
        versionCode = 2
        versionName = "2.0.0"
        ndk { abiFilters += novaAbi.get() }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging {
        jniLibs { useLegacyPackaging = true }
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}
