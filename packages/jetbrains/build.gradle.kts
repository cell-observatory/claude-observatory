// Claude Observatory for JetBrains IDEs (PyCharm, IntelliJ, …).
// Front-end only: all store mutations go through the `claude-observatory` CLI (see packages/cli);
// cheap reads come straight off the on-disk store. Platform-only dependency → runs in every
// JetBrains IDE, and on the Gateway/remote-dev backend (where ~/.claude lives).
plugins {
    id("java")
    kotlin("jvm") version "2.2.0"
    id("org.jetbrains.intellij.platform") version "2.17.0"
}

group = "com.cell-observatory"
version = "0.2.1" // keep in lockstep with the monorepo/vscode version (see root package.json)

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // Compile against the canonical platform baseline; the plugin declares only
        // com.intellij.modules.platform so it loads in PyCharm CE/Pro and every other JetBrains IDE.
        intellijIdeaCommunity("2025.2")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

kotlin { jvmToolchain(21) }

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "252"
            untilBuild = provider { null }
        }
    }
}
