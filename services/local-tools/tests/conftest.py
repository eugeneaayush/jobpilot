import pytest


@pytest.fixture
def resume():
    return {
        "basics": {"name": "Alex Example", "email": "alex@example.com", "phone": "+1 212 555 0123", "website": "https://example.com", "linkedin": "https://linkedin.com/in/example", "github": "https://github.com/example", "headline": "Investment Associate", "location": "New York, NY"},
        "summary": "Investment analysis and research experience across public markets.",
        "experience": [{"id": "work-1", "company": "Example Capital", "title": "Analyst", "start": "Fall 2020", "bullets": ["Analyzed 10 companies using Python and financial modeling.", "Prepared research for the investment team."]}],
        "projects": [{"id": "project-1", "name": "Research Library", "url": "https://example.com/research", "description": "Public market research", "keywords": ["PE", "VC", "AI", "C++", "C#"], "bullets": ["Built a documented research workflow."]}],
        "skills": [{"id": "skill-1", "group": "Analysis", "items": ["Python", "PE", "VC", "AI", "C++", "C#"]}],
        "education": [{"id": "edu-1", "school": "Example University", "degree": "MBA / MS", "start": "2024", "details": ["Investment research coursework"]}],
        "publications": [{"id": "pub-1", "title": "Research Note", "authors": "Alex Example, Taylor Sample et al.", "year": "In press", "venue": "Research Journal", "doi": "10.1000/example", "url": "https://example.com/note"}],
        "awards": [{"id": "award-1", "title": "Research Prize", "issuer": "Example University", "year": "2025", "description": "Recognized research quality"}],
        "certifications": [{"id": "cert-1", "name": "Research Methods", "issuer": "Example Institute", "issued": "2025", "credentialId": "ABC-123", "url": "https://example.com/cert"}],
        "sections": [{"id": "section-1", "title": "Service", "entries": [{"id": "custom-1", "heading": "Mentoring", "subheading": "Example Group", "meta": "2025", "bullets": ["Mentored students in financial modeling."]}]}],
    }


@pytest.fixture(autouse=True)
def private_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path
