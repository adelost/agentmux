plugins {
    id("java-library")
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

dependencies {
    api(project(":link-core"))
    implementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
}
