import type { ResumeData } from "@jobpilot/contracts/resume";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: {
    fontFamily: "Times-Roman",
    fontSize: 10,
    paddingHorizontal: 39.6,
    paddingVertical: 31,
    lineHeight: 1.02,
  },
  name: {
    fontFamily: "Times-Bold",
    fontSize: 15,
    lineHeight: 1.2,
    textAlign: "center",
    marginBottom: 3,
  },
  contact: { textAlign: "center", lineHeight: 1.1, fontSize: 9, marginBottom: 7 },
  section: {
    fontFamily: "Times-Bold",
    fontSize: 10,
    borderBottomWidth: 0.6,
    marginTop: 4,
    marginBottom: 2,
    paddingBottom: 1,
  },
  row: { flexDirection: "row", justifyContent: "space-between" },
  bold: { fontFamily: "Times-Bold" },
  italic: { fontFamily: "Times-Italic" },
  entry: { marginBottom: 2 },
  bullet: { marginLeft: 9, marginBottom: 0.4 },
  detail: { marginBottom: 0.4 },
});
const dates = (start?: string, end?: string) => [start, end].filter(Boolean).join(" – ");
const bullets = (items: string[]) =>
  items.map((item) => (
    <Text key={item} style={styles.bullet}>
      • {item}
    </Text>
  ));
export function CbsTemplate({
  data,
  unresolvedFacts = false,
  maxPages = 1,
}: {
  data: ResumeData;
  unresolvedFacts?: boolean;
  maxPages?: 1 | 2;
}) {
  return (
    <Document title={`${data.basics.name} Resume`} author={data.basics.name}>
      <Page size="LETTER" style={styles.page}>
        {maxPages === 2 && (
          <Text
            fixed
            style={{ position: "absolute", bottom: 12, right: 39.6, fontSize: 7 }}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        )}
        {unresolvedFacts && (
          <Text
            fixed
            style={{
              position: "absolute",
              bottom: 15,
              left: 39.6,
              right: 39.6,
              fontSize: 7,
              fontFamily: "Times-Italic",
              textAlign: "center",
            }}
          >
            DRAFT — unresolved source facts; not ready for submission
          </Text>
        )}
        <Text style={styles.name}>{data.basics.name}</Text>
        <Text style={styles.contact}>
          {[
            data.basics.location,
            data.basics.phone,
            data.basics.email,
            data.basics.linkedin,
            data.basics.website,
            data.basics.github,
          ]
            .filter(Boolean)
            .join(" | ")}
        </Text>
        {data.summary && <Text style={styles.detail}>{data.summary}</Text>}
        {data.education.length > 0 && <Text style={styles.section}>EDUCATION</Text>}
        {data.education.map((entry, index) => (
          <View key={entry.id ?? index} style={styles.entry}>
            <View style={styles.row}>
              <Text style={styles.bold}>{entry.school}</Text>
              <Text>{dates(entry.start, entry.end)}</Text>
            </View>
            <Text style={styles.italic}>{entry.degree}</Text>
            {bullets(entry.details)}
          </View>
        ))}
        {data.experience.length > 0 && <Text style={styles.section}>EXPERIENCE</Text>}
        {data.experience.map((entry, index) => (
          <View key={entry.id ?? index} style={styles.entry}>
            <View style={styles.row}>
              <Text style={styles.bold}>{entry.company}</Text>
              <Text>{entry.location}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.italic}>{entry.title}</Text>
              <Text>{dates(entry.start, entry.end)}</Text>
            </View>
            {bullets(entry.bullets)}
          </View>
        ))}
        {data.projects.length > 0 && <Text style={styles.section}>PROJECTS</Text>}
        {data.projects.map((entry, index) => (
          <View key={entry.id ?? index} style={styles.entry}>
            <Text style={styles.bold}>{entry.name}</Text>
            <Text>{entry.description}</Text>
            {bullets(entry.bullets)}
          </View>
        ))}
        {(data.skills.length > 0 ||
          data.publications.length > 0 ||
          data.awards.length > 0 ||
          data.certifications.length > 0) && (
          <Text style={styles.section}>ADDITIONAL INFORMATION</Text>
        )}
        {data.skills.map((entry, index) => (
          <Text key={entry.id ?? index}>
            <Text style={styles.bold}>{entry.group}: </Text>
            {entry.items.join(", ")}
          </Text>
        ))}
        {data.publications.map((entry, index) => (
          <Text key={entry.id ?? index}>
            {[entry.title, entry.authors, entry.venue, entry.year, entry.url, entry.doi]
              .filter(Boolean)
              .join("; ")}
          </Text>
        ))}
        {data.awards.map((entry, index) => (
          <Text key={entry.id ?? index}>
            {[entry.title, entry.issuer, entry.year, entry.description].filter(Boolean).join("; ")}
          </Text>
        ))}
        {data.certifications.map((entry, index) => (
          <Text key={entry.id ?? index}>
            {[entry.name, entry.issuer, entry.issued, entry.expires, entry.credentialId, entry.url]
              .filter(Boolean)
              .join("; ")}
          </Text>
        ))}
        {data.sections.map((section, index) => (
          <View key={section.id ?? index}>
            <Text style={styles.section}>{section.title.toUpperCase()}</Text>
            {section.entries.map((entry, entryIndex) => (
              <View key={entry.id ?? entryIndex} style={styles.detail}>
                <Text>
                  <Text style={styles.bold}>{entry.heading}: </Text>
                  {[entry.subheading, entry.meta, ...entry.bullets].filter(Boolean).join(" ")}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}
