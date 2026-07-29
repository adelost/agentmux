plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "io.agentmux.audioinbox.wear"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.agentmux.audioinbox.wear"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-preview"
        buildConfigField(
            "String",
            "UPDATE_MANIFEST_URL",
            "\"https://link.v1d.io/releases/agentmux-link/wear/manifest-v1.json\"",
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":link-core"))
    implementation("io.v1d.circlekit:ringkit:0.2.1")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    testImplementation("junit:junit:4.13.2")
}
